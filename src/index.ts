#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  DAPClient,
  Breakpoint,
  StackFrame,
  Variable,
  StoppedEventBody,
  OutputEventBody,
} from "./dap-client.js";
import * as path from "path";
import * as fs from "fs";
import { ChildProcess, spawn, execSync, spawnSync } from "child_process";

// State
let dapClient: DAPClient | null = null;
const breakpointsByFile = new Map<string, Map<number, Breakpoint>>();
const outputBuffer: string[] = [];
let lastStoppedReason: string | null = null;
let lastStoppedThreadId: number | null = null;

// Session state for restart capability
interface SessionState {
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
let currentSession: SessionState | null = null;

// Hot reload (watch mode) state
interface WatchState {
  watchProcess: ChildProcess;
  projectPath: string;
  launchProfile?: string;
  lastChildPid: number | null;
  reconnecting: boolean;
  reconnectPromise: Promise<void> | null;
}
let watchState: WatchState | null = null;

// Find child .NET process spawned by dotnet watch
function findDotnetChildPid(watchPid: number, projectName: string): number | null {
  try {
    // Find child processes of dotnet watch that are running our project DLL
    const result = execSync(
      `pgrep -P ${watchPid} -a 2>/dev/null || ps --ppid ${watchPid} -o pid,args --no-headers 2>/dev/null`,
      { encoding: "utf-8", timeout: 5000 }
    ).trim();

    if (!result) return null;

    // Parse output to find the .NET process running our project
    const lines = result.split("\n");
    for (const line of lines) {
      if (line.includes(projectName) && line.includes(".dll")) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!isNaN(pid)) return pid;
      }
    }

    // Fallback: find any dotnet child process
    for (const line of lines) {
      if (line.includes("dotnet") && !line.includes("watch")) {
        const pid = parseInt(line.trim().split(/\s+/)[0], 10);
        if (!isNaN(pid)) return pid;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// Check if a process is still running
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Auto-reconnect logic for watch mode
async function watchReconnect(): Promise<void> {
  if (!watchState || watchState.reconnecting) return;

  watchState.reconnecting = true;
  outputBuffer.push("[Hot Reload] Detecting app restart, reconnecting debugger...\n");

  // Disconnect existing client
  if (dapClient) {
    try {
      await dapClient.disconnect(false);
    } catch {
      // Ignore
    }
    dapClient = null;
  }

  // Wait for new process to spawn (poll for up to 30 seconds)
  const projectName = path.basename(watchState.projectPath);
  let newPid: number | null = null;
  const startTime = Date.now();

  while (Date.now() - startTime < 30000) {
    await new Promise((r) => setTimeout(r, 500));

    if (!watchState?.watchProcess.pid) break;

    newPid = findDotnetChildPid(watchState.watchProcess.pid, projectName);
    if (newPid && newPid !== watchState.lastChildPid) {
      // Give the process a moment to initialize
      await new Promise((r) => setTimeout(r, 1000));
      break;
    }
  }

  if (!newPid) {
    outputBuffer.push("[Hot Reload] Failed to find new process, watch mode may be broken\n");
    watchState.reconnecting = false;
    return;
  }

  // Attach to new process
  try {
    dapClient = new DAPClient();

    dapClient.on("stopped", (body: StoppedEventBody) => {
      lastStoppedReason = body.reason;
      lastStoppedThreadId = body.threadId || null;
    });

    dapClient.on("output", (body: OutputEventBody) => {
      if (body.output) {
        outputBuffer.push(body.output);
        while (outputBuffer.length > 100) {
          outputBuffer.shift();
        }
      }
    });

    dapClient.on("terminated", () => {
      // Process terminated, may need to reconnect
      if (watchState && !watchState.reconnecting) {
        watchState.reconnectPromise = watchReconnect();
      }
    });

    await dapClient.start();
    await dapClient.attach(newPid);

    watchState.lastChildPid = newPid;

    // Reapply breakpoints
    for (const [file, bps] of breakpointsByFile) {
      const lines = Array.from(bps.keys());
      if (lines.length > 0) {
        try {
          const breakpoints = lines.map((l) => ({ line: l }));
          await dapClient.setBreakpoints(file, breakpoints);
        } catch {
          // Ignore breakpoint errors during reconnect
        }
      }
    }

    if (currentSession) {
      currentSession.processId = newPid;
      currentSession.startTime = new Date();
    }

    outputBuffer.push(`[Hot Reload] Reconnected to process ${newPid}\n`);
  } catch (err) {
    const error = err as Error;
    outputBuffer.push(`[Hot Reload] Reconnect failed: ${error.message}\n`);
  }

  watchState.reconnecting = false;
}

// Stale code detection - compare source vs compiled modification times
function checkCodeStaleness(): { stale: boolean; message?: string } {
  try {
    // Get paths relative to this file's location
    const compiledPath = new URL(import.meta.url).pathname;
    const srcDir = path.resolve(path.dirname(compiledPath), "..", "src");
    const sourcePath = path.join(srcDir, "index.ts");

    if (!fs.existsSync(sourcePath)) {
      return { stale: false }; // Can't check if source doesn't exist
    }

    const compiledStat = fs.statSync(compiledPath);
    const sourceStat = fs.statSync(sourcePath);

    if (sourceStat.mtimeMs > compiledStat.mtimeMs) {
      const diffMs = sourceStat.mtimeMs - compiledStat.mtimeMs;
      const diffMins = Math.round(diffMs / 60000);
      return {
        stale: true,
        message: `⚠️ Source code is ${diffMins > 0 ? diffMins + " minute(s)" : "seconds"} newer than compiled code. Run 'npm run build' and restart MCP server to pick up changes.`,
      };
    }

    return { stale: false };
  } catch {
    return { stale: false }; // Fail silently
  }
}

// Create MCP server
const server = new McpServer({
  name: "mcp-netcoredbg",
  version: "1.0.0",
});

// Helper functions
function requireDebugger(): DAPClient {
  // Check if we're reconnecting in watch mode
  if (watchState?.reconnecting) {
    throw new Error(
      "Debugger is reconnecting after hot reload. Please wait a moment and try again."
    );
  }

  if (!dapClient || !dapClient.isRunning()) {
    throw new Error(
      "Debugger not running. Use 'launch' or 'launch_watch' to start a debug session."
    );
  }
  return dapClient;
}

function formatStackFrame(frame: StackFrame): string {
  const location = frame.source?.path
    ? `${frame.source.path}:${frame.line}`
    : frame.source?.name || "unknown";
  return `#${frame.id} ${frame.name} at ${location}`;
}

function formatVariable(v: Variable, indent = 0): string {
  const prefix = "  ".repeat(indent);
  const type = v.type ? ` (${v.type})` : "";
  return `${prefix}${v.name}${type} = ${v.value}`;
}

// Helper to read and parse launchSettings.json
interface LaunchProfile {
  commandName?: string;
  environmentVariables?: Record<string, string>;
  applicationUrl?: string;
  dotnetRunMessages?: boolean;
}

interface LaunchSettings {
  profiles?: Record<string, LaunchProfile>;
}

function readLaunchSettings(programPath: string): LaunchSettings | null {
  const programDir = path.dirname(programPath);
  // Walk up from bin/Debug/net*/app.dll to find Properties/launchSettings.json
  // Typical structure: ProjectDir/bin/Debug/net8.0/app.dll
  // We need: ProjectDir/Properties/launchSettings.json
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

function resolveEnvironment(
  launchProfile: string | undefined,
  explicitEnv: Record<string, string> | undefined,
  programPath: string
): Record<string, string> {
  const resolved: Record<string, string> = {};

  // If launchProfile specified, try to read settings
  if (launchProfile) {
    const settings = readLaunchSettings(programPath);
    if (settings?.profiles?.[launchProfile]) {
      const profile = settings.profiles[launchProfile];

      // Add environment variables from profile
      if (profile.environmentVariables) {
        Object.assign(resolved, profile.environmentVariables);
      }

      // Extract applicationUrl and set ASPNETCORE_URLS
      if (profile.applicationUrl) {
        resolved["ASPNETCORE_URLS"] = profile.applicationUrl;
      }
    }
  }

  // Explicit env overrides profile settings
  if (explicitEnv) {
    Object.assign(resolved, explicitEnv);
  }

  return resolved;
}

// Tool: launch
server.tool(
  "launch",
  "Start debugging a .NET application. The program should be the path to a DLL file built with debug symbols.",
  {
    program: z.string().describe("Path to the .NET DLL to debug"),
    args: z
      .array(z.string())
      .optional()
      .describe("Command line arguments for the program"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the program"),
    stopAtEntry: z
      .boolean()
      .optional()
      .default(false)
      .describe("Stop at the entry point of the program"),
    env: z
      .record(z.string())
      .optional()
      .describe("Environment variables to pass to the debuggee process"),
    launchProfile: z
      .string()
      .optional()
      .describe("Name of a launch profile from Properties/launchSettings.json to use for environment variables and URLs"),
  },
  async ({ program, args, cwd, stopAtEntry, env, launchProfile }) => {
    // Clean up existing session
    if (dapClient) {
      try {
        await dapClient.disconnect(true);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clear state
    breakpointsByFile.clear();
    outputBuffer.length = 0;
    lastStoppedReason = null;
    lastStoppedThreadId = null;

    // Start new client
    dapClient = new DAPClient();

    // Set up event handlers
    dapClient.on("stopped", (body: StoppedEventBody) => {
      lastStoppedReason = body.reason;
      lastStoppedThreadId = body.threadId || null;
    });

    dapClient.on("output", (body: OutputEventBody) => {
      if (body.output) {
        outputBuffer.push(body.output);
        // Keep only last 100 lines
        while (outputBuffer.length > 100) {
          outputBuffer.shift();
        }
      }
    });

    dapClient.on("terminated", () => {
      dapClient = null;
    });

    dapClient.on("error", (err: Error) => {
      console.error("DAP error:", err.message);
    });

    // Initialize and launch
    const capabilities = await dapClient.start();

    // Resolve environment variables from launchProfile and explicit env
    const resolvedEnv = resolveEnvironment(launchProfile, env, program);

    const launchRequest: Record<string, unknown> = {
      program,
      args: args || [],
      cwd: cwd || process.cwd(),
      stopAtEntry: stopAtEntry || false,
      console: "internalConsole",
    };

    // Only include env if we have environment variables to pass
    if (Object.keys(resolvedEnv).length > 0) {
      launchRequest.env = resolvedEnv;
    }

    await dapClient.sendRequest("launch", launchRequest);

    await dapClient.sendRequest("configurationDone", {});

    // Save session state for restart capability
    currentSession = {
      program,
      args,
      cwd,
      stopAtEntry,
      launchProfile,
      env,
      resolvedEnv,
      startTime: new Date(),
      mode: "launch",
    };

    // Build status message
    let statusMsg = `Debugger started for: ${program}`;
    statusMsg += `\nCapabilities: ${Object.keys(capabilities).filter((k) => capabilities[k] === true).join(", ")}`;

    if (launchProfile) {
      statusMsg += `\nUsing launch profile: ${launchProfile}`;
    }

    if (Object.keys(resolvedEnv).length > 0) {
      statusMsg += `\nEnvironment variables: ${Object.keys(resolvedEnv).join(", ")}`;
    }

    statusMsg += stopAtEntry ? "\nStopped at entry point." : "\nProgram is running. Set breakpoints or pause to inspect.";

    return {
      content: [
        {
          type: "text" as const,
          text: statusMsg,
        },
      ],
    };
  }
);

// Tool: attach
server.tool(
  "attach",
  "Attach debugger to a running .NET process",
  {
    processId: z.number().describe("Process ID to attach to"),
  },
  async ({ processId }) => {
    if (dapClient) {
      try {
        await dapClient.disconnect(false);
      } catch {
        // Ignore
      }
    }

    breakpointsByFile.clear();
    outputBuffer.length = 0;

    dapClient = new DAPClient();

    dapClient.on("stopped", (body: StoppedEventBody) => {
      lastStoppedReason = body.reason;
      lastStoppedThreadId = body.threadId || null;
    });

    dapClient.on("output", (body: OutputEventBody) => {
      if (body.output) {
        outputBuffer.push(body.output);
        while (outputBuffer.length > 100) {
          outputBuffer.shift();
        }
      }
    });

    await dapClient.start();
    await dapClient.attach(processId);

    // Save session state for attach mode
    currentSession = {
      program: `process:${processId}`,
      resolvedEnv: {},
      processId,
      startTime: new Date(),
      mode: "attach",
    };

    return {
      content: [
        {
          type: "text" as const,
          text: `Attached to process ${processId}`,
        },
      ],
    };
  }
);

// Tool: launch_watch - Hot reload support via dotnet watch
server.tool(
  "launch_watch",
  "Start debugging with hot reload support using 'dotnet watch'. The debugger will automatically reconnect when the app restarts after code changes.",
  {
    projectPath: z.string().describe("Path to the .NET project directory (containing .csproj)"),
    launchProfile: z
      .string()
      .optional()
      .describe("Name of a launch profile from Properties/launchSettings.json"),
    args: z
      .array(z.string())
      .optional()
      .describe("Additional arguments to pass to dotnet watch"),
  },
  async ({ projectPath, launchProfile, args }) => {
    // Clean up any existing watch state
    if (watchState) {
      try {
        watchState.watchProcess.kill();
      } catch {
        // Ignore
      }
      watchState = null;
    }

    // Clean up existing debug session
    if (dapClient) {
      try {
        await dapClient.disconnect(true);
      } catch {
        // Ignore cleanup errors
      }
    }

    // Clear state
    breakpointsByFile.clear();
    outputBuffer.length = 0;
    lastStoppedReason = null;
    lastStoppedThreadId = null;

    // Resolve project path
    const resolvedProjectPath = path.isAbsolute(projectPath)
      ? projectPath
      : path.resolve(process.cwd(), projectPath);

    if (!fs.existsSync(resolvedProjectPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Project path not found: ${resolvedProjectPath}`,
          },
        ],
      };
    }

    // Build dotnet watch arguments
    const watchArgs = ["watch", "run", "--no-launch-profile"];

    if (launchProfile) {
      // Read environment variables from launch profile and pass them via environment
      const projectName = path.basename(resolvedProjectPath);
      const possibleDllPaths = [
        path.join(resolvedProjectPath, "bin", "Debug", "net10.0", `${projectName}.dll`),
        path.join(resolvedProjectPath, "bin", "Debug", "net9.0", `${projectName}.dll`),
        path.join(resolvedProjectPath, "bin", "Debug", "net8.0", `${projectName}.dll`),
      ];
      const dllPath = possibleDllPaths.find(p => fs.existsSync(p)) || possibleDllPaths[0];
      const envFromProfile = resolveEnvironment(launchProfile, undefined, dllPath);

      // We'll pass these through process.env for the spawn
      Object.assign(process.env, envFromProfile);
    }

    if (args && args.length > 0) {
      watchArgs.push("--", ...args);
    }

    outputBuffer.push(`[Watch] Starting: dotnet ${watchArgs.join(" ")}\n`);
    outputBuffer.push(`[Watch] Working directory: ${resolvedProjectPath}\n`);

    // Start dotnet watch
    const watchProcess = spawn("dotnet", watchArgs, {
      cwd: resolvedProjectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    // Capture output
    watchProcess.stdout?.on("data", (data) => {
      const text = data.toString();
      outputBuffer.push(text);
      while (outputBuffer.length > 100) {
        outputBuffer.shift();
      }
    });

    watchProcess.stderr?.on("data", (data) => {
      const text = `[stderr] ${data.toString()}`;
      outputBuffer.push(text);
      while (outputBuffer.length > 100) {
        outputBuffer.shift();
      }
    });

    watchProcess.on("exit", (code) => {
      outputBuffer.push(`[Watch] Process exited with code ${code}\n`);
      watchState = null;
    });

    // Initialize watch state
    watchState = {
      watchProcess,
      projectPath: resolvedProjectPath,
      launchProfile,
      lastChildPid: null,
      reconnecting: false,
      reconnectPromise: null,
    };

    // Wait for child process to spawn (poll for up to 30 seconds)
    const projectName = path.basename(resolvedProjectPath);
    let childPid: number | null = null;
    const startTime = Date.now();

    outputBuffer.push(`[Watch] Waiting for app to start...\n`);

    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 1000));

      if (!watchProcess.pid) {
        return {
          content: [
            {
              type: "text" as const,
              text: "dotnet watch failed to start",
            },
          ],
        };
      }

      childPid = findDotnetChildPid(watchProcess.pid, projectName);
      if (childPid) {
        // Give the process a moment to fully initialize
        await new Promise((r) => setTimeout(r, 2000));
        break;
      }
    }

    if (!childPid) {
      // Clean up
      try {
        watchProcess.kill();
      } catch {
        // Ignore
      }
      watchState = null;

      return {
        content: [
          {
            type: "text" as const,
            text: `Timeout waiting for app to start. Check output:\n${outputBuffer.slice(-10).join("")}`,
          },
        ],
      };
    }

    watchState.lastChildPid = childPid;
    outputBuffer.push(`[Watch] Found child process: ${childPid}\n`);

    // Attach debugger to child process
    dapClient = new DAPClient();

    dapClient.on("stopped", (body: StoppedEventBody) => {
      lastStoppedReason = body.reason;
      lastStoppedThreadId = body.threadId || null;
    });

    dapClient.on("output", (body: OutputEventBody) => {
      if (body.output) {
        outputBuffer.push(body.output);
        while (outputBuffer.length > 100) {
          outputBuffer.shift();
        }
      }
    });

    dapClient.on("terminated", () => {
      // Process terminated, may need to reconnect for hot reload
      if (watchState && !watchState.reconnecting) {
        watchState.reconnectPromise = watchReconnect();
      }
    });

    try {
      await dapClient.start();
      await dapClient.attach(childPid);
    } catch (err) {
      const error = err as Error;
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to attach debugger: ${error.message}`,
          },
        ],
      };
    }

    // Save session state
    currentSession = {
      program: resolvedProjectPath,
      launchProfile,
      resolvedEnv: {},
      processId: childPid,
      startTime: new Date(),
      mode: "watch",
    };

    let statusMsg = `🔥 Hot reload debugging started`;
    statusMsg += `\nProject: ${resolvedProjectPath}`;
    statusMsg += `\nAttached to process: ${childPid}`;
    if (launchProfile) {
      statusMsg += `\nLaunch profile: ${launchProfile}`;
    }
    statusMsg += `\n\nThe debugger will automatically reconnect when the app restarts after code changes.`;
    statusMsg += `\nUse 'stop_watch' to stop hot reload mode.`;

    return {
      content: [
        {
          type: "text" as const,
          text: statusMsg,
        },
      ],
    };
  }
);

// Tool: stop_watch - Stop hot reload mode
server.tool(
  "stop_watch",
  "Stop hot reload debugging mode and terminate the dotnet watch process",
  {},
  async () => {
    if (!watchState) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No watch session active",
          },
        ],
      };
    }

    // Disconnect debugger
    if (dapClient) {
      try {
        await dapClient.disconnect(false);
      } catch {
        // Ignore
      }
      dapClient = null;
    }

    // Kill watch process
    try {
      watchState.watchProcess.kill("SIGTERM");
    } catch {
      // Ignore
    }

    watchState = null;
    breakpointsByFile.clear();
    outputBuffer.length = 0;
    lastStoppedReason = null;
    lastStoppedThreadId = null;
    currentSession = null;

    return {
      content: [
        {
          type: "text" as const,
          text: "Hot reload debugging stopped",
        },
      ],
    };
  }
);

// Tool: set_breakpoint
server.tool(
  "set_breakpoint",
  "Set a breakpoint at a specific line in a source file",
  {
    file: z.string().describe("Absolute path to the source file"),
    line: z.number().describe("Line number (1-based)"),
    condition: z
      .string()
      .optional()
      .describe("Optional condition expression for the breakpoint"),
  },
  async ({ file, line, condition }) => {
    const client = requireDebugger();

    // Get existing breakpoints for this file
    let fileBreakpoints = breakpointsByFile.get(file);
    if (!fileBreakpoints) {
      fileBreakpoints = new Map();
      breakpointsByFile.set(file, fileBreakpoints);
    }

    // Add new breakpoint to the set
    const allLines = Array.from(fileBreakpoints.keys());
    if (!allLines.includes(line)) {
      allLines.push(line);
    }

    // Set all breakpoints for this file
    const breakpoints = allLines.map((l) => ({
      line: l,
      condition: l === line ? condition : fileBreakpoints!.get(l)?.message,
    }));

    const result = await client.setBreakpoints(file, breakpoints);

    // Update our map
    fileBreakpoints.clear();
    for (const bp of result) {
      if (bp.line) {
        fileBreakpoints.set(bp.line, bp);
      }
    }

    const setBp = result.find((bp) => bp.line === line);
    if (setBp?.verified) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Breakpoint set at ${file}:${line}${condition ? ` (condition: ${condition})` : ""}`,
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: "text" as const,
            text: `Breakpoint at ${file}:${line} pending verification (${setBp?.message || "source may not be loaded yet"})`,
          },
        ],
      };
    }
  }
);

// Tool: remove_breakpoint
server.tool(
  "remove_breakpoint",
  "Remove a breakpoint from a specific line",
  {
    file: z.string().describe("Absolute path to the source file"),
    line: z.number().describe("Line number of the breakpoint to remove"),
  },
  async ({ file, line }) => {
    const client = requireDebugger();

    const fileBreakpoints = breakpointsByFile.get(file);
    if (!fileBreakpoints || !fileBreakpoints.has(line)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No breakpoint found at ${file}:${line}`,
          },
        ],
      };
    }

    fileBreakpoints.delete(line);

    const remainingLines = Array.from(fileBreakpoints.keys());
    const breakpoints = remainingLines.map((l) => ({ line: l }));

    await client.setBreakpoints(file, breakpoints);

    return {
      content: [
        {
          type: "text" as const,
          text: `Breakpoint removed from ${file}:${line}`,
        },
      ],
    };
  }
);

// Tool: list_breakpoints
server.tool(
  "list_breakpoints",
  "List all active breakpoints",
  {},
  async () => {
    requireDebugger();

    const allBreakpoints: string[] = [];

    for (const [file, bps] of breakpointsByFile) {
      for (const [line, bp] of bps) {
        const status = bp.verified ? "verified" : "pending";
        allBreakpoints.push(`${file}:${line} [${status}]`);
      }
    }

    if (allBreakpoints.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No breakpoints set",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Breakpoints:\n${allBreakpoints.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: continue
server.tool(
  "continue",
  "Continue program execution until next breakpoint or program end",
  {
    threadId: z
      .number()
      .optional()
      .describe("Thread ID to continue (defaults to current thread)"),
  },
  async ({ threadId }) => {
    const client = requireDebugger();
    await client.continue(threadId);

    return {
      content: [
        {
          type: "text" as const,
          text: "Continuing execution...",
        },
      ],
    };
  }
);

// Tool: pause
server.tool(
  "pause",
  "Pause program execution",
  {
    threadId: z
      .number()
      .optional()
      .describe("Thread ID to pause (defaults to all threads)"),
  },
  async ({ threadId }) => {
    const client = requireDebugger();
    await client.pause(threadId);

    return {
      content: [
        {
          type: "text" as const,
          text: "Execution paused",
        },
      ],
    };
  }
);

// Tool: step_over
server.tool(
  "step_over",
  "Step over the current line (execute it without stepping into functions)",
  {
    threadId: z.number().optional().describe("Thread ID"),
  },
  async ({ threadId }) => {
    const client = requireDebugger();
    await client.stepOver(threadId);

    return {
      content: [
        {
          type: "text" as const,
          text: "Stepped over",
        },
      ],
    };
  }
);

// Tool: step_into
server.tool(
  "step_into",
  "Step into the function call on the current line",
  {
    threadId: z.number().optional().describe("Thread ID"),
  },
  async ({ threadId }) => {
    const client = requireDebugger();
    await client.stepInto(threadId);

    return {
      content: [
        {
          type: "text" as const,
          text: "Stepped into",
        },
      ],
    };
  }
);

// Tool: step_out
server.tool(
  "step_out",
  "Step out of the current function",
  {
    threadId: z.number().optional().describe("Thread ID"),
  },
  async ({ threadId }) => {
    const client = requireDebugger();
    await client.stepOut(threadId);

    return {
      content: [
        {
          type: "text" as const,
          text: "Stepped out",
        },
      ],
    };
  }
);

// Tool: stack_trace
server.tool(
  "stack_trace",
  "Get the current call stack",
  {
    threadId: z.number().optional().describe("Thread ID"),
    depth: z
      .number()
      .optional()
      .default(20)
      .describe("Maximum number of frames to return"),
  },
  async ({ threadId, depth }) => {
    const client = requireDebugger();
    const frames = await client.getStackTrace(threadId, 0, depth);

    if (frames.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No stack frames available. Is the program stopped?",
          },
        ],
      };
    }

    const formatted = frames.map(formatStackFrame).join("\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Call Stack:\n${formatted}`,
        },
      ],
    };
  }
);

// Tool: scopes
server.tool(
  "scopes",
  "Get variable scopes for a stack frame",
  {
    frameId: z.number().describe("Stack frame ID (from stack_trace)"),
  },
  async ({ frameId }) => {
    const client = requireDebugger();
    const scopes = await client.getScopes(frameId);

    const lines = scopes.map(
      (s) => `${s.name} (ref: ${s.variablesReference}, expensive: ${s.expensive})`
    );

    return {
      content: [
        {
          type: "text" as const,
          text: `Scopes:\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: variables
server.tool(
  "variables",
  "Get variables from a scope or variable container",
  {
    variablesReference: z
      .number()
      .describe("Variables reference (from scopes or parent variable)"),
    maxDepth: z
      .number()
      .optional()
      .default(1)
      .describe("How deep to expand nested objects (default 1)"),
  },
  async ({ variablesReference, maxDepth }) => {
    const client = requireDebugger();

    async function getVarsRecursive(
      ref: number,
      depth: number,
      indent: number
    ): Promise<string[]> {
      const vars = await client.getVariables(ref);
      const lines: string[] = [];

      for (const v of vars) {
        lines.push(formatVariable(v, indent));
        if (v.variablesReference > 0 && depth > 0) {
          const children = await getVarsRecursive(
            v.variablesReference,
            depth - 1,
            indent + 1
          );
          lines.push(...children);
        }
      }

      return lines;
    }

    const lines = await getVarsRecursive(variablesReference, maxDepth, 0);

    if (lines.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No variables in this scope",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Variables:\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// Tool: evaluate
server.tool(
  "evaluate",
  "Evaluate an expression in the current debug context",
  {
    expression: z.string().describe("Expression to evaluate"),
    frameId: z
      .number()
      .optional()
      .describe("Stack frame ID for context (from stack_trace)"),
  },
  async ({ expression, frameId }) => {
    const client = requireDebugger();
    const result = await client.evaluate(expression, frameId, "repl");

    const type = result.type ? ` (${result.type})` : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `${expression}${type} = ${result.result}`,
        },
      ],
    };
  }
);

// Tool: threads
server.tool("threads", "List all threads in the debugged process", {}, async () => {
  const client = requireDebugger();
  const threads = await client.getThreads();

  const current = client.getCurrentThreadId();
  const lines = threads.map(
    (t) => `${t.id === current ? "* " : "  "}Thread ${t.id}: ${t.name}`
  );

  return {
    content: [
      {
        type: "text" as const,
        text: `Threads:\n${lines.join("\n")}`,
      },
    ],
  };
});

// Tool: output
server.tool(
  "output",
  "Get recent program output (stdout/stderr)",
  {
    lines: z
      .number()
      .optional()
      .default(20)
      .describe("Number of recent lines to return"),
  },
  async ({ lines }) => {
    requireDebugger();

    const recent = outputBuffer.slice(-lines);
    if (recent.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No output captured yet",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Program output:\n${recent.join("")}`,
        },
      ],
    };
  }
);

// Tool: status
server.tool(
  "status",
  "Get current debugger status (running, stopped, etc.)",
  {},
  async () => {
    if (!dapClient || !dapClient.isRunning()) {
      let text = "Debugger not running";

      // Still check for stale code even when not running
      const staleness = checkCodeStaleness();
      if (staleness.stale && staleness.message) {
        text += `\n\n${staleness.message}`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text,
          },
        ],
      };
    }

    const threadId = dapClient.getCurrentThreadId();
    let status = "Running";

    if (lastStoppedReason) {
      status = `Stopped (${lastStoppedReason})`;
      if (threadId) {
        status += ` on thread ${threadId}`;
      }
    }

    const bpCount = Array.from(breakpointsByFile.values()).reduce(
      (acc, m) => acc + m.size,
      0
    );

    // Build detailed status with session info
    let statusText = `Status: ${status}\nBreakpoints: ${bpCount}\nOutput lines buffered: ${outputBuffer.length}`;

    if (currentSession) {
      statusText += `\n\nSession Info:`;
      statusText += `\n  Mode: ${currentSession.mode}`;
      statusText += `\n  Program: ${currentSession.program}`;
      if (currentSession.launchProfile) {
        statusText += `\n  Launch Profile: ${currentSession.launchProfile}`;
      }
      if (currentSession.processId) {
        statusText += `\n  Process ID: ${currentSession.processId}`;
      }
      if (currentSession.cwd) {
        statusText += `\n  Working Dir: ${currentSession.cwd}`;
      }
      const envKeys = Object.keys(currentSession.resolvedEnv);
      if (envKeys.length > 0) {
        statusText += `\n  Env Vars: ${envKeys.join(", ")}`;
      }
      const uptime = Math.floor((Date.now() - currentSession.startTime.getTime()) / 1000);
      statusText += `\n  Uptime: ${uptime}s`;
    }

    // Watch mode specific info
    if (watchState) {
      statusText += `\n\nHot Reload Info:`;
      statusText += `\n  Watch Process PID: ${watchState.watchProcess.pid || "unknown"}`;
      statusText += `\n  Child App PID: ${watchState.lastChildPid || "waiting..."}`;
      statusText += `\n  Reconnecting: ${watchState.reconnecting ? "Yes (please wait)" : "No"}`;
    }

    // Check for stale code
    const staleness = checkCodeStaleness();
    if (staleness.stale && staleness.message) {
      statusText += `\n\n${staleness.message}`;
    }

    return {
      content: [
        {
          type: "text" as const,
          text: statusText,
        },
      ],
    };
  }
);

// Tool: terminate
server.tool(
  "terminate",
  "Stop the debug session and terminate the debugged program",
  {},
  async () => {
    if (!dapClient) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No active debug session",
          },
        ],
      };
    }

    await dapClient.terminate();
    dapClient = null;
    breakpointsByFile.clear();
    outputBuffer.length = 0;
    lastStoppedReason = null;
    lastStoppedThreadId = null;
    currentSession = null;

    return {
      content: [
        {
          type: "text" as const,
          text: "Debug session terminated",
        },
      ],
    };
  }
);

// Tool: restart
server.tool(
  "restart",
  "Restart the debugged program using the same launch settings. Useful after code changes.",
  {
    rebuild: z.boolean().optional().default(false).describe("Run 'dotnet build' before restarting (for code changes)"),
  },
  async ({ rebuild }) => {
    if (!currentSession || currentSession.mode !== "launch") {
      return {
        content: [
          {
            type: "text" as const,
            text: "No launch session to restart. Use 'launch' to start a debug session first.",
          },
        ],
      };
    }

    const session = currentSession;

    // Terminate current session
    if (dapClient) {
      try {
        await dapClient.terminate();
      } catch {
        // Ignore cleanup errors
      }
    }

    // Optionally rebuild
    if (rebuild) {
      const { execSync } = await import("child_process");
      const projectDir = session.cwd || path.dirname(session.program);
      try {
        execSync("dotnet build", { cwd: projectDir, encoding: "utf-8", stdio: "pipe" });
      } catch (err) {
        const error = err as Error & { stderr?: string };
        return {
          content: [
            {
              type: "text" as const,
              text: `Rebuild failed: ${error.stderr || error.message}`,
            },
          ],
        };
      }
    }

    // Clear state
    breakpointsByFile.clear();
    outputBuffer.length = 0;
    lastStoppedReason = null;
    lastStoppedThreadId = null;

    // Start new client
    dapClient = new DAPClient();

    dapClient.on("stopped", (body: StoppedEventBody) => {
      lastStoppedReason = body.reason;
      lastStoppedThreadId = body.threadId || null;
    });

    dapClient.on("output", (body: OutputEventBody) => {
      if (body.output) {
        outputBuffer.push(body.output);
        while (outputBuffer.length > 100) {
          outputBuffer.shift();
        }
      }
    });

    dapClient.on("terminated", () => {
      dapClient = null;
    });

    dapClient.on("error", (err: Error) => {
      console.error("DAP error:", err.message);
    });

    // Initialize and launch
    await dapClient.start();

    interface LaunchRequestExtended {
      program: string;
      args: string[];
      cwd: string;
      stopAtEntry: boolean;
      console: string;
      env?: Record<string, string>;
    }

    const launchRequest: LaunchRequestExtended = {
      program: session.program,
      args: session.args || [],
      cwd: session.cwd || process.cwd(),
      stopAtEntry: session.stopAtEntry || false,
      console: "internalConsole",
    };

    if (Object.keys(session.resolvedEnv).length > 0) {
      launchRequest.env = session.resolvedEnv;
    }

    await dapClient.sendRequest("launch", launchRequest);
    await dapClient.sendRequest("configurationDone", {});

    // Update session start time
    currentSession = {
      ...session,
      startTime: new Date(),
    };

    let statusMsg = `Restarted: ${session.program}`;
    if (rebuild) {
      statusMsg += "\n(Rebuilt before restart)";
    }
    if (session.launchProfile) {
      statusMsg += `\nUsing launch profile: ${session.launchProfile}`;
    }
    statusMsg += "\nProgram is running. Set breakpoints or pause to inspect.";

    return {
      content: [
        {
          type: "text" as const,
          text: statusMsg,
        },
      ],
    };
  }
);

// Tool: invoke

// Get harness path relative to this file
const harnessDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "harness"
);
const harnessDll = path.join(
  harnessDir,
  "bin",
  "Debug",
  "net8.0",
  "McpNetcoreDbg.Harness.dll"
);

// Build harness if needed
async function ensureHarnessBuilt(): Promise<{ success: boolean; error?: string }> {
  if (fs.existsSync(harnessDll)) {
    return { success: true };
  }

  // Check if harness source exists
  const csproj = path.join(harnessDir, "McpNetcoreDbg.Harness.csproj");
  if (!fs.existsSync(csproj)) {
    return {
      success: false,
      error: `Harness project not found at ${harnessDir}. Please ensure the MCP server is installed correctly.`,
    };
  }

  // Build the harness
  const result = spawnSync("dotnet", ["build", "-c", "Debug"], {
    cwd: harnessDir,
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });

  if (result.status !== 0) {
    return {
      success: false,
      error: `Failed to build harness: ${result.stderr || result.stdout}`,
    };
  }

  return { success: true };
}

interface InvokeResult {
  success: boolean;
  method?: string;
  args?: unknown[];
  returnType?: string;
  returnValue?: unknown;
  durationMs?: number;
  logs?: Array<{ level: string; message: string; category?: string }>;
  stdout?: string;
  error?: string;
  errorDetails?: {
    type?: string;
    reason?: string;
    constructors?: Array<{ params: string[] }>;
    methods?: Array<{
      name: string;
      params: string[];
      returnType: string;
      isStatic: boolean;
    }>;
    stackTrace?: string;
  };
}

async function runHarness(requestJson: string): Promise<InvokeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("dotnet", [harnessDll, requestJson], {
      cwd: harnessDir,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      try {
        const result = JSON.parse(stdout) as InvokeResult;
        resolve(result);
      } catch {
        resolve({
          success: false,
          error: `Failed to parse harness output: ${stdout || stderr}`,
          errorDetails: { reason: stderr || "Unknown error" },
        });
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
}

server.tool(
  "invoke",
  "Invoke a specific method in a .NET assembly. Can run with or without debugging. Use debug mode to set breakpoints and step through the code.",
  {
    assembly: z.string().describe("Path to the .NET DLL containing the type"),
    type: z.string().describe("Fully qualified type name (e.g., 'MyApp.Services.Calculator')"),
    method: z.string().describe("Method name to invoke"),
    args: z
      .array(z.any())
      .optional()
      .describe("Method arguments as JSON array"),
    ctorArgs: z
      .array(z.any())
      .optional()
      .describe("Constructor arguments for instance methods"),
    debug: z
      .boolean()
      .optional()
      .default(false)
      .describe("Launch under debugger for breakpoint support"),
    cwd: z
      .string()
      .optional()
      .describe("Working directory for the invocation"),
  },
  async ({ assembly, type, method, args, ctorArgs, debug, cwd }) => {
    // Ensure harness is built (auto-build if needed)
    const buildResult = await ensureHarnessBuilt();
    if (!buildResult.success) {
      return {
        content: [
          {
            type: "text" as const,
            text: buildResult.error || "Failed to build harness",
          },
        ],
      };
    }

    // Resolve assembly path
    const resolvedAssembly = path.isAbsolute(assembly)
      ? assembly
      : path.resolve(cwd || process.cwd(), assembly);

    if (!fs.existsSync(resolvedAssembly)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Assembly not found: ${resolvedAssembly}`,
          },
        ],
      };
    }

    // Build request JSON
    const request = {
      assembly: resolvedAssembly,
      type,
      method,
      args: args || [],
      ctorArgs: ctorArgs || [],
    };

    const requestJson = JSON.stringify(request);

    if (debug) {
      // Launch under debugger
      if (dapClient) {
        try {
          await dapClient.disconnect(true);
        } catch {
          // Ignore cleanup errors
        }
      }

      breakpointsByFile.clear();
      outputBuffer.length = 0;
      lastStoppedReason = null;
      lastStoppedThreadId = null;

      dapClient = new DAPClient();

      dapClient.on("stopped", (body: StoppedEventBody) => {
        lastStoppedReason = body.reason;
        lastStoppedThreadId = body.threadId || null;
      });

      dapClient.on("output", (body: OutputEventBody) => {
        if (body.output) {
          outputBuffer.push(body.output);
          while (outputBuffer.length > 100) {
            outputBuffer.shift();
          }
        }
      });

      dapClient.on("terminated", () => {
        dapClient = null;
      });

      dapClient.on("error", (err: Error) => {
        console.error("DAP error:", err.message);
      });

      await dapClient.start();

      await dapClient.sendRequest("launch", {
        program: harnessDll,
        args: [requestJson],
        cwd: cwd || path.dirname(resolvedAssembly),
        stopAtEntry: false,
        console: "internalConsole",
      });

      await dapClient.sendRequest("configurationDone", {});

      return {
        content: [
          {
            type: "text" as const,
            text: `Invoking ${type}.${method} under debugger.\nSet breakpoints in your source files, then use 'continue' to run.\nUse 'output' to see the result when complete.`,
          },
        ],
      };
    } else {
      // Run directly without debugging
      try {
        const result = await runHarness(requestJson);

        if (result.success) {
          let response = `✓ ${result.method}\n`;
          response += `Duration: ${result.durationMs?.toFixed(2)}ms\n`;
          response += `Return type: ${result.returnType}\n`;
          response += `Return value: ${JSON.stringify(result.returnValue, null, 2)}`;

          if (result.logs && result.logs.length > 0) {
            response += `\n\nLogs:\n`;
            for (const log of result.logs) {
              response += `  [${log.level}] ${log.message}\n`;
            }
          }

          if (result.stdout && result.stdout.trim()) {
            response += `\nStdout:\n${result.stdout}`;
          }

          return {
            content: [
              {
                type: "text" as const,
                text: response,
              },
            ],
          };
        } else {
          let response = `✗ ${result.error}\n`;

          if (result.errorDetails) {
            if (result.errorDetails.reason) {
              response += `Reason: ${result.errorDetails.reason}\n`;
            }

            if (result.errorDetails.constructors) {
              response += `\nAvailable constructors:\n`;
              for (const ctor of result.errorDetails.constructors) {
                response += `  (${ctor.params.join(", ")})\n`;
              }
            }

            if (result.errorDetails.methods) {
              response += `\nAvailable methods:\n`;
              for (const m of result.errorDetails.methods) {
                const staticMod = m.isStatic ? "static " : "";
                response += `  ${staticMod}${m.returnType} ${m.name}(${m.params.join(", ")})\n`;
              }
            }

            if (result.errorDetails.stackTrace) {
              response += `\nStack trace:\n${result.errorDetails.stackTrace}`;
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: response,
              },
            ],
          };
        }
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to run harness: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
