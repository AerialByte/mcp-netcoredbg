/**
 * DebugSession - Encapsulates all state for a single debug session.
 *
 * This class holds all the per-session state that was previously global:
 * - DAPClient instance
 * - Breakpoints by file
 * - Output buffer
 * - Execution state (stopped reason, thread ID)
 * - Watch mode state (for hot reload)
 * - Session configuration
 */

import {
  DAPClient,
  Breakpoint,
  StackFrame,
  Variable,
  Scope,
  Thread,
  StoppedEventBody,
  OutputEventBody,
} from "./dap-client.js";
import { ChildProcess, spawn, execSync } from "child_process";
import * as path from "path";
import * as fs from "fs";

// Session configuration
export interface SessionConfig {
  program: string;
  args?: string[];
  cwd?: string;
  stopAtEntry?: boolean;
  launchProfile?: string;
  env?: Record<string, string>;
  resolvedEnv: Record<string, string>;
  processId?: number;
  startTime: Date;
  mode: "launch" | "attach" | "watch";
}

// Hot reload (watch mode) state
export interface WatchState {
  watchProcess: ChildProcess;
  projectPath: string;
  launchProfile?: string;
  lastChildPid: number | null;
  reconnecting: boolean;
  reconnectPromise: Promise<void> | null;
  ports: number[]; // Ports used by the app (for port release detection)
  earlyCleanupDone: boolean; // Track if early cleanup was done in current cycle
  noHotReload: boolean; // Whether hot reload is disabled (full restarts only)
}

// Session status for external queries
export interface SessionStatus {
  state: "running" | "stopped" | "reconnecting" | "terminated";
  stoppedReason?: string;
  stoppedThreadId?: number;
  processId?: number;
  uptime: number; // seconds
  breakpointCount: number;
  outputLineCount: number;
}

// Launch profile interfaces
interface LaunchProfile {
  commandName?: string;
  environmentVariables?: Record<string, string>;
  applicationUrl?: string;
  dotnetRunMessages?: boolean;
}

interface LaunchSettings {
  profiles?: Record<string, LaunchProfile>;
}

/**
 * A single debug session encapsulating all per-session state.
 */
export class DebugSession {
  readonly id: string;

  // DAP client for this session
  private dapClient: DAPClient | null = null;

  // Session-specific state
  // We store breakpoints and their conditions separately because the DAP
  // Breakpoint response doesn't include the original condition we set
  private breakpointsByFile = new Map<string, Map<number, Breakpoint>>();
  private conditionsByFile = new Map<string, Map<number, string | undefined>>();
  private outputBuffer: string[] = [];
  private lastStoppedReason: string | null = null;
  private lastStoppedThreadId: number | null = null;

  // Watch mode state (if applicable)
  private watchState: WatchState | null = null;

  // Session metadata
  private config: SessionConfig | null = null;

  constructor(id: string) {
    this.id = id;
  }

  // ==================== Core Lifecycle ====================

  /**
   * Start a launch debug session
   */
  async launch(params: {
    program: string;
    args?: string[];
    cwd?: string;
    stopAtEntry?: boolean;
    env?: Record<string, string>;
    launchProfile?: string;
  }): Promise<{ capabilities: Record<string, unknown>; resolvedEnv: Record<string, string> }> {
    // Clear any existing state
    await this.cleanup();

    // Start new client
    this.dapClient = new DAPClient();
    this.setupEventHandlers();

    // Initialize
    const capabilities = await this.dapClient.start();

    // Resolve environment variables from launchProfile and explicit env
    const resolvedEnv = this.resolveEnvironment(params.launchProfile, params.env, params.program);

    const launchRequest: Record<string, unknown> = {
      program: params.program,
      args: params.args || [],
      cwd: params.cwd || process.cwd(),
      stopAtEntry: params.stopAtEntry || false,
      console: "internalConsole",
    };

    // Only include env if we have environment variables to pass
    if (Object.keys(resolvedEnv).length > 0) {
      launchRequest.env = resolvedEnv;
    }

    await this.dapClient.sendRequest("launch", launchRequest);
    await this.dapClient.sendRequest("configurationDone", {});

    // Save session config
    this.config = {
      program: params.program,
      args: params.args,
      cwd: params.cwd,
      stopAtEntry: params.stopAtEntry,
      launchProfile: params.launchProfile,
      env: params.env,
      resolvedEnv,
      startTime: new Date(),
      mode: "launch",
    };

    return { capabilities, resolvedEnv };
  }

  /**
   * Attach to an existing process
   */
  async attach(processId: number): Promise<void> {
    // Clear any existing state
    await this.cleanup();

    this.dapClient = new DAPClient();
    this.setupEventHandlers();

    await this.dapClient.start();
    await this.dapClient.attach(processId);

    // Save session config
    this.config = {
      program: `process:${processId}`,
      resolvedEnv: {},
      processId,
      startTime: new Date(),
      mode: "attach",
    };
  }

  /**
   * Start hot reload watch mode
   */
  async launchWatch(params: {
    projectPath: string;
    launchProfile?: string;
    args?: string[];
    noHotReload?: boolean;
  }): Promise<{ watchPid: number; childPid: number }> {
    // Clear any existing state
    await this.cleanup();

    const resolvedProjectPath = path.isAbsolute(params.projectPath)
      ? params.projectPath
      : path.resolve(process.cwd(), params.projectPath);

    if (!fs.existsSync(resolvedProjectPath)) {
      throw new Error(`Project path not found: ${resolvedProjectPath}`);
    }

    // Build dotnet watch arguments
    const watchArgs = ["watch"];

    if (params.noHotReload) {
      watchArgs.push("--no-hot-reload");
    }

    watchArgs.push("run");

    if (params.launchProfile) {
      watchArgs.push("--launch-profile", params.launchProfile);
    } else {
      watchArgs.push("--no-launch-profile");
    }

    if (params.args && params.args.length > 0) {
      watchArgs.push("--", ...params.args);
    }

    this.outputBuffer.push(`[Watch] Starting: dotnet ${watchArgs.join(" ")}\n`);
    this.outputBuffer.push(`[Watch] Working directory: ${resolvedProjectPath}\n`);

    // Extract ports from launch profile for port monitoring
    const ports = this.extractPortsFromLaunchProfile(resolvedProjectPath, params.launchProfile);

    // Start dotnet watch
    const watchProcess = spawn("dotnet", watchArgs, {
      cwd: resolvedProjectPath,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        DOTNET_WATCH_RESTART_ON_RUDE_EDIT: "true",
      },
    });

    // Initialize watch state
    this.watchState = {
      watchProcess,
      projectPath: resolvedProjectPath,
      launchProfile: params.launchProfile,
      lastChildPid: null,
      reconnecting: false,
      reconnectPromise: null,
      ports,
      earlyCleanupDone: false,
      noHotReload: params.noHotReload || false,
    };

    // Capture watch output
    watchProcess.stdout?.on("data", (data) => {
      const text = data.toString();
      this.outputBuffer.push(text);
      this.trimOutputBuffer();

      // Detect rebuild starting (early cleanup opportunity)
      if (
        text.includes("Building...") &&
        this.watchState?.lastChildPid &&
        !this.watchState.earlyCleanupDone
      ) {
        this.handleEarlyCleanup();
      }
    });

    watchProcess.stderr?.on("data", (data) => {
      const text = data.toString();
      this.outputBuffer.push(`[stderr] ${text}`);
      this.trimOutputBuffer();
    });

    watchProcess.on("exit", (code) => {
      this.outputBuffer.push(`[Watch] Process exited with code ${code}\n`);
      this.watchState = null;
    });

    // Wait for the app to start and find the child process
    const childPid = await this.waitForChildProcess(resolvedProjectPath, 30000);
    if (!childPid) {
      watchProcess.kill();
      this.watchState = null;
      throw new Error("Failed to find child process started by dotnet watch");
    }

    // Attach debugger to the child process
    this.dapClient = new DAPClient();
    this.setupEventHandlers();

    await this.dapClient.start();
    await this.dapClient.attach(childPid);

    this.watchState.lastChildPid = childPid;

    // Find the DLL path for session config
    const dllPath = this.findProjectDll(resolvedProjectPath) || `watch:${resolvedProjectPath}`;

    // Save session config
    this.config = {
      program: dllPath,
      args: params.args,
      cwd: resolvedProjectPath,
      launchProfile: params.launchProfile,
      resolvedEnv: {},
      processId: childPid,
      startTime: new Date(),
      mode: "watch",
    };

    // Start polling for process changes (hot reload detection)
    this.startWatchPolling();

    return { watchPid: watchProcess.pid!, childPid };
  }

  /**
   * Stop watch mode
   */
  async stopWatch(): Promise<void> {
    if (!this.watchState) {
      throw new Error("Not in watch mode");
    }

    // Kill the watch process
    try {
      this.watchState.watchProcess.kill();
    } catch {
      // Ignore
    }

    // Disconnect debugger
    await this.cleanup();
  }

  /**
   * Terminate the debug session
   */
  async terminate(): Promise<void> {
    if (this.watchState) {
      await this.stopWatch();
    } else {
      await this.cleanup();
    }
  }

  /**
   * Restart the session (for launch mode only)
   */
  async restart(rebuild: boolean = false): Promise<void> {
    if (!this.config || this.config.mode !== "launch") {
      throw new Error("Restart is only supported for launch mode");
    }

    // Optionally rebuild
    if (rebuild) {
      const programDir = path.dirname(this.config.program);
      // Walk up to find csproj
      let searchDir = programDir;
      for (let i = 0; i < 5; i++) {
        const csprojFiles = fs.readdirSync(searchDir).filter((f) => f.endsWith(".csproj"));
        if (csprojFiles.length > 0) {
          execSync("dotnet build", { cwd: searchDir, encoding: "utf-8" });
          break;
        }
        const parent = path.dirname(searchDir);
        if (parent === searchDir) break;
        searchDir = parent;
      }
    }

    // Relaunch with same config
    await this.launch({
      program: this.config.program,
      args: this.config.args,
      cwd: this.config.cwd,
      stopAtEntry: this.config.stopAtEntry,
      env: this.config.env,
      launchProfile: this.config.launchProfile,
    });
  }

  // ==================== Breakpoint Management ====================

  async setBreakpoint(
    file: string,
    line: number,
    condition?: string
  ): Promise<Breakpoint> {
    const client = this.requireClient();

    // Normalize path
    const normalizedPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);

    // Get or create breakpoint maps for this file
    let fileBps = this.breakpointsByFile.get(normalizedPath);
    if (!fileBps) {
      fileBps = new Map();
      this.breakpointsByFile.set(normalizedPath, fileBps);
    }

    let fileConditions = this.conditionsByFile.get(normalizedPath);
    if (!fileConditions) {
      fileConditions = new Map();
      this.conditionsByFile.set(normalizedPath, fileConditions);
    }

    // Store the condition for the new breakpoint
    fileConditions.set(line, condition);

    // Collect all breakpoints for this file (using stored conditions)
    const allBps: Array<{ line: number; condition?: string }> = [];
    for (const [existingLine] of fileBps) {
      const existingCondition = fileConditions.get(existingLine);
      allBps.push({ line: existingLine, condition: existingCondition });
    }
    // Add the new one if not already present
    if (!fileBps.has(line)) {
      allBps.push({ line, condition });
    }

    // Set all breakpoints
    const result = await client.setBreakpoints(normalizedPath, allBps);

    // Find the new breakpoint in result
    const newBp = result.find((bp) => bp.line === line);
    if (newBp) {
      fileBps.set(line, newBp);
      return newBp;
    }

    throw new Error(`Failed to set breakpoint at ${file}:${line}`);
  }

  async removeBreakpoint(file: string, line: number): Promise<void> {
    const client = this.requireClient();

    const normalizedPath = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
    const fileBps = this.breakpointsByFile.get(normalizedPath);
    const fileConditions = this.conditionsByFile.get(normalizedPath);

    if (!fileBps || !fileBps.has(line)) {
      throw new Error(`No breakpoint at ${file}:${line}`);
    }

    fileBps.delete(line);
    fileConditions?.delete(line);

    // Re-set remaining breakpoints (using stored conditions)
    const remainingBps: Array<{ line: number; condition?: string }> = [];
    for (const [existingLine] of fileBps) {
      const existingCondition = fileConditions?.get(existingLine);
      remainingBps.push({ line: existingLine, condition: existingCondition });
    }

    await client.setBreakpoints(normalizedPath, remainingBps);
  }

  listBreakpoints(): Breakpoint[] {
    const all: Breakpoint[] = [];
    for (const fileBps of this.breakpointsByFile.values()) {
      for (const bp of fileBps.values()) {
        all.push(bp);
      }
    }
    return all;
  }

  // ==================== Execution Control ====================

  async continue(threadId?: number): Promise<void> {
    const client = this.requireClient();
    await client.continue(threadId || this.lastStoppedThreadId || 1);
    this.lastStoppedReason = null;
    this.lastStoppedThreadId = null;
  }

  async pause(threadId?: number): Promise<void> {
    const client = this.requireClient();
    await client.pause(threadId || 1);
  }

  async stepOver(threadId?: number): Promise<void> {
    const client = this.requireClient();
    await client.stepOver(threadId || this.lastStoppedThreadId || 1);
  }

  async stepInto(threadId?: number): Promise<void> {
    const client = this.requireClient();
    await client.stepInto(threadId || this.lastStoppedThreadId || 1);
  }

  async stepOut(threadId?: number): Promise<void> {
    const client = this.requireClient();
    await client.stepOut(threadId || this.lastStoppedThreadId || 1);
  }

  // ==================== Inspection ====================

  async getStackTrace(threadId?: number, depth: number = 20): Promise<StackFrame[]> {
    const client = this.requireClient();
    const tid = threadId || this.lastStoppedThreadId || 1;
    return client.getStackTrace(tid, depth);
  }

  async getScopes(frameId: number): Promise<Scope[]> {
    const client = this.requireClient();
    return client.getScopes(frameId);
  }

  async getVariables(variablesReference: number): Promise<Variable[]> {
    const client = this.requireClient();
    return client.getVariables(variablesReference);
  }

  async evaluate(expression: string, frameId?: number): Promise<{ result: string; type?: string; variablesReference: number }> {
    const client = this.requireClient();
    return client.evaluate(expression, frameId);
  }

  async getThreads(): Promise<Thread[]> {
    const client = this.requireClient();
    return client.getThreads();
  }

  // ==================== Output ====================

  getOutput(lines: number = 20): string[] {
    return this.outputBuffer.slice(-lines);
  }

  clearOutput(): void {
    this.outputBuffer.length = 0;
  }

  addOutput(text: string): void {
    this.outputBuffer.push(text);
    this.trimOutputBuffer();
  }

  // ==================== Status ====================

  isRunning(): boolean {
    return this.dapClient !== null && this.dapClient.isRunning();
  }

  isReconnecting(): boolean {
    return this.watchState?.reconnecting || false;
  }

  isWatchMode(): boolean {
    return this.watchState !== null;
  }

  getConfig(): SessionConfig | null {
    return this.config;
  }

  getStatus(): SessionStatus {
    let state: SessionStatus["state"] = "terminated";

    if (this.watchState?.reconnecting) {
      state = "reconnecting";
    } else if (this.dapClient?.isRunning()) {
      state = this.lastStoppedReason ? "stopped" : "running";
    }

    const uptime = this.config?.startTime
      ? Math.floor((Date.now() - this.config.startTime.getTime()) / 1000)
      : 0;

    let breakpointCount = 0;
    for (const fileBps of this.breakpointsByFile.values()) {
      breakpointCount += fileBps.size;
    }

    return {
      state,
      stoppedReason: this.lastStoppedReason || undefined,
      stoppedThreadId: this.lastStoppedThreadId || undefined,
      processId: this.config?.processId,
      uptime,
      breakpointCount,
      outputLineCount: this.outputBuffer.length,
    };
  }

  getWatchState(): WatchState | null {
    return this.watchState;
  }

  getBreakpointsByFile(): Map<string, Map<number, Breakpoint>> {
    return this.breakpointsByFile;
  }

  // ==================== Private Helpers ====================

  private requireClient(): DAPClient {
    if (this.watchState?.reconnecting) {
      throw new Error(
        "Debugger is reconnecting after hot reload. Please wait a moment and try again."
      );
    }

    if (!this.dapClient || !this.dapClient.isRunning()) {
      throw new Error(
        `Session '${this.id}' debugger not running. Use 'launch' or 'launch_watch' to start.`
      );
    }
    return this.dapClient;
  }

  private setupEventHandlers(): void {
    if (!this.dapClient) return;

    this.dapClient.on("stopped", (body: StoppedEventBody) => {
      this.lastStoppedReason = body.reason;
      this.lastStoppedThreadId = body.threadId || null;
    });

    this.dapClient.on("output", (body: OutputEventBody) => {
      if (body.output) {
        this.outputBuffer.push(body.output);
        this.trimOutputBuffer();
      }
    });

    this.dapClient.on("terminated", () => {
      // Process terminated, may need to reconnect if in watch mode
      if (this.watchState && !this.watchState.reconnecting) {
        this.watchState.reconnectPromise = this.watchReconnect();
      }
    });

    this.dapClient.on("error", (err: Error) => {
      console.error(`[${this.id}] DAP error:`, err.message);
    });
  }

  private async cleanup(): Promise<void> {
    // Disconnect DAP client
    if (this.dapClient) {
      try {
        await this.dapClient.disconnect(true);
      } catch {
        // Ignore cleanup errors
      }
      this.dapClient = null;
    }

    // Clear state
    this.breakpointsByFile.clear();
    this.outputBuffer.length = 0;
    this.lastStoppedReason = null;
    this.lastStoppedThreadId = null;
  }

  private trimOutputBuffer(): void {
    while (this.outputBuffer.length > 100) {
      this.outputBuffer.shift();
    }
  }

  // ==================== Environment Resolution ====================

  private resolveEnvironment(
    launchProfile: string | undefined,
    explicitEnv: Record<string, string> | undefined,
    programPath: string
  ): Record<string, string> {
    const resolved: Record<string, string> = {};

    if (launchProfile) {
      const settings = this.readLaunchSettings(programPath);
      if (settings?.profiles?.[launchProfile]) {
        const profile = settings.profiles[launchProfile];
        if (profile.environmentVariables) {
          Object.assign(resolved, profile.environmentVariables);
        }
        if (profile.applicationUrl) {
          resolved["ASPNETCORE_URLS"] = profile.applicationUrl;
        }
      }
    }

    if (explicitEnv) {
      Object.assign(resolved, explicitEnv);
    }

    return resolved;
  }

  private readLaunchSettings(programPath: string): LaunchSettings | null {
    const programDir = path.dirname(programPath);
    let searchDir = programDir;
    for (let i = 0; i < 5; i++) {
      const launchSettingsPath = path.join(searchDir, "Properties", "launchSettings.json");
      if (fs.existsSync(launchSettingsPath)) {
        try {
          const content = fs.readFileSync(launchSettingsPath, "utf-8");
          return JSON.parse(content) as LaunchSettings;
        } catch {
          return null;
        }
      }
      const parent = path.dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }
    return null;
  }

  // ==================== Watch Mode Helpers ====================

  private extractPortsFromLaunchProfile(projectPath: string, launchProfile?: string): number[] {
    if (!launchProfile) return [];

    const launchSettingsPath = path.join(projectPath, "Properties", "launchSettings.json");
    if (!fs.existsSync(launchSettingsPath)) return [];

    try {
      const content = fs.readFileSync(launchSettingsPath, "utf-8");
      const settings = JSON.parse(content) as LaunchSettings;
      const profile = settings.profiles?.[launchProfile];
      if (!profile?.applicationUrl) return [];

      const ports: number[] = [];
      const urls = profile.applicationUrl.split(";");
      for (const url of urls) {
        const match = url.match(/:(\d+)/);
        if (match) {
          ports.push(parseInt(match[1], 10));
        }
      }
      return ports;
    } catch {
      return [];
    }
  }

  private async waitForChildProcess(projectPath: string, timeoutMs: number): Promise<number | null> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      await new Promise((r) => setTimeout(r, 500));

      if (!this.watchState?.watchProcess.pid) break;

      const pid = this.findDotnetChildPid(this.watchState.watchProcess.pid, projectPath);
      if (pid) {
        // Give the process a moment to initialize
        await new Promise((r) => setTimeout(r, 1000));
        return pid;
      }
    }

    return null;
  }

  private findDotnetChildPid(watchPid: number, projectPath: string): number | null {
    try {
      const allProcesses = execSync(
        `ps -e --format pid,args --no-headers 2>/dev/null`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();

      const lines = allProcesses.split("\n");
      const searchPath = `${projectPath}/bin/`;

      // Look for a process running from the project's bin directory
      for (const line of lines) {
        const trimmed = line.trim();
        if (
          trimmed.includes(searchPath) &&
          !trimmed.includes("watch") &&
          !trimmed.includes("MSBuild") &&
          !trimmed.includes("dotnet-watch.dll") &&
          !trimmed.includes("grep")
        ) {
          const pid = parseInt(trimmed.split(/\s+/)[0], 10);
          if (!isNaN(pid)) {
            return pid;
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  private findProjectDll(projectPath: string): string | null {
    try {
      const binDebugPath = path.join(projectPath, "bin", "Debug");
      if (!fs.existsSync(binDebugPath)) return null;

      const netDirs = fs.readdirSync(binDebugPath).filter((d) => d.startsWith("net"));
      if (netDirs.length === 0) return null;

      const netDir = path.join(binDebugPath, netDirs[0]);
      const projectName = path.basename(projectPath);
      const dllPath = path.join(netDir, `${projectName}.dll`);

      return fs.existsSync(dllPath) ? dllPath : null;
    } catch {
      return null;
    }
  }

  private startWatchPolling(): void {
    // Poll for process death to trigger reconnection
    const pollInterval = setInterval(async () => {
      if (!this.watchState) {
        clearInterval(pollInterval);
        return;
      }

      // Check if watch process itself is still running
      if (!this.isProcessRunning(this.watchState.watchProcess.pid!)) {
        this.outputBuffer.push("[Watch] Watch process terminated\n");
        this.watchState = null;
        clearInterval(pollInterval);
        return;
      }

      // Check if child process died (triggers reconnection)
      if (
        this.watchState.lastChildPid &&
        !this.isProcessRunning(this.watchState.lastChildPid) &&
        !this.watchState.reconnecting
      ) {
        // Child died, trigger reconnect
        this.watchState.reconnectPromise = this.watchReconnect();
      }
    }, 1000);
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async handleEarlyCleanup(): Promise<void> {
    if (!this.watchState || this.watchState.earlyCleanupDone) return;

    this.watchState.earlyCleanupDone = true;
    this.outputBuffer.push("[Hot Reload] Early rebuild detection, cleaning up old process...\n");

    // Disconnect debugger early
    if (this.dapClient) {
      try {
        await this.dapClient.disconnect(false);
      } catch {
        // Ignore
      }
      this.dapClient = null;
    }

    // Kill old process
    const oldPid = this.watchState.lastChildPid;
    if (oldPid && this.isProcessRunning(oldPid)) {
      try {
        process.kill(oldPid, "SIGKILL");
      } catch {
        // Ignore
      }
    }

    // Wait for ports
    if (this.watchState.ports.length > 0) {
      await this.waitForPortsRelease(this.watchState.ports, 10000);
    }
  }

  private async watchReconnect(skipCleanup: boolean = false): Promise<void> {
    if (!this.watchState) return;
    if (!skipCleanup && this.watchState.reconnecting) return;

    this.watchState.reconnecting = true;
    const oldPid = this.watchState.lastChildPid;

    if (!skipCleanup) {
      this.outputBuffer.push("[Hot Reload] Detecting app restart, reconnecting debugger...\n");

      if (oldPid) {
        await this.cleanupOldProcess(oldPid);
      }
    }

    // Attach to new process
    await this.attachToNewProcess(oldPid);

    this.watchState.reconnecting = false;
    this.watchState.earlyCleanupDone = false;
  }

  private async cleanupOldProcess(oldPid: number): Promise<void> {
    // Disconnect existing client
    if (this.dapClient) {
      try {
        await this.dapClient.disconnect(false);
      } catch {
        // Ignore
      }
      this.dapClient = null;
    }

    // Kill the old process if still running
    if (this.isProcessRunning(oldPid)) {
      this.outputBuffer.push(`[Hot Reload] Killing orphaned process ${oldPid}...\n`);
      try {
        process.kill(oldPid, "SIGKILL");
      } catch {
        // Ignore
      }
    }

    // Wait for process termination
    const terminateStart = Date.now();
    while (Date.now() - terminateStart < 5000) {
      if (!this.isProcessRunning(oldPid)) {
        this.outputBuffer.push(`[Hot Reload] Process ${oldPid} terminated\n`);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // Wait for ports
    if (this.watchState?.ports && this.watchState.ports.length > 0) {
      this.outputBuffer.push(
        `[Hot Reload] Waiting for ports: ${this.watchState.ports.join(", ")}...\n`
      );
      await this.waitForPortsRelease(this.watchState.ports, 10000);
    }
  }

  private async attachToNewProcess(oldPid: number | null): Promise<boolean> {
    if (!this.watchState) return false;

    // Wait for new process
    let newPid: number | null = null;
    const startTime = Date.now();

    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 500));

      if (!this.watchState?.watchProcess.pid) break;

      newPid = this.findDotnetChildPid(this.watchState.watchProcess.pid, this.watchState.projectPath);
      if (newPid && newPid !== oldPid) {
        await new Promise((r) => setTimeout(r, 1000));
        break;
      }
    }

    if (!newPid) {
      this.outputBuffer.push("[Hot Reload] Failed to find new process\n");
      return false;
    }

    // Attach to new process
    try {
      this.dapClient = new DAPClient();
      this.setupEventHandlers();

      await this.dapClient.start();
      await this.dapClient.attach(newPid);

      this.watchState.lastChildPid = newPid;

      // Reapply breakpoints
      for (const [file, bps] of this.breakpointsByFile) {
        const lines = Array.from(bps.keys());
        if (lines.length > 0) {
          try {
            const breakpoints = lines.map((l) => ({ line: l }));
            await this.dapClient.setBreakpoints(file, breakpoints);
          } catch {
            // Ignore breakpoint errors during reconnect
          }
        }
      }

      if (this.config) {
        this.config.processId = newPid;
        this.config.startTime = new Date();
      }

      this.outputBuffer.push(`[Hot Reload] Reconnected to process ${newPid}\n`);
      return true;
    } catch (err) {
      const error = err as Error;
      this.outputBuffer.push(`[Hot Reload] Reconnect failed: ${error.message}\n`);
      return false;
    }
  }

  private async waitForPortsRelease(
    ports: number[],
    maxWaitMs: number
  ): Promise<{ released: boolean; portsStillInUse: number[] }> {
    const startTime = Date.now();
    const checkIntervalMs = 300;

    while (Date.now() - startTime < maxWaitMs) {
      const inUsePorts = ports.filter((p) => this.isPortInUse(p));
      if (inUsePorts.length === 0) {
        this.outputBuffer.push("[Hot Reload] All ports released\n");
        return { released: true, portsStillInUse: [] };
      }
      await new Promise((r) => setTimeout(r, checkIntervalMs));
    }

    const stillInUse = ports.filter((p) => this.isPortInUse(p));
    if (stillInUse.length > 0) {
      this.outputBuffer.push(`[Hot Reload] Warning: Ports still in use: ${stillInUse.join(", ")}\n`);
    }
    return { released: stillInUse.length === 0, portsStillInUse: stillInUse };
  }

  private isPortInUse(port: number): boolean {
    try {
      const result = execSync(
        `ss -tln 2>/dev/null | grep -q ':${port} ' && echo "in_use" || echo "free"`,
        { encoding: "utf-8", timeout: 1000 }
      ).trim();
      return result === "in_use";
    } catch {
      return false;
    }
  }
}
