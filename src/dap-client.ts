import { spawn, ChildProcess } from "child_process";
import { EventEmitter } from "events";

// DAP Message Types
export interface DAPMessage {
  seq: number;
  type: "request" | "response" | "event";
}

export interface DAPRequest extends DAPMessage {
  type: "request";
  command: string;
  arguments?: unknown;
}

export interface DAPResponse extends DAPMessage {
  type: "response";
  request_seq: number;
  success: boolean;
  command: string;
  message?: string;
  body?: unknown;
}

export interface DAPEvent extends DAPMessage {
  type: "event";
  event: string;
  body?: unknown;
}

// DAP Types
export interface Source {
  name?: string;
  path?: string;
  sourceReference?: number;
}

export interface SourceBreakpoint {
  line: number;
  column?: number;
  condition?: string;
  hitCondition?: string;
  logMessage?: string;
}

export interface Breakpoint {
  id?: number;
  verified: boolean;
  message?: string;
  source?: Source;
  line?: number;
  column?: number;
}

export interface StackFrame {
  id: number;
  name: string;
  source?: Source;
  line: number;
  column: number;
  moduleId?: number | string;
}

export interface Scope {
  name: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
  expensive: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  namedVariables?: number;
  indexedVariables?: number;
}

export interface Thread {
  id: number;
  name: string;
}

export interface Capabilities {
  supportsConfigurationDoneRequest?: boolean;
  supportsFunctionBreakpoints?: boolean;
  supportsConditionalBreakpoints?: boolean;
  supportsEvaluateForHovers?: boolean;
  supportsSetVariable?: boolean;
  supportsStepBack?: boolean;
  supportsTerminateRequest?: boolean;
  [key: string]: unknown;
}

// Event body types
export interface StoppedEventBody {
  reason: string;
  threadId?: number;
  allThreadsStopped?: boolean;
  text?: string;
}

export interface OutputEventBody {
  category?: string;
  output: string;
  source?: Source;
  line?: number;
}

export interface TerminatedEventBody {
  restart?: boolean;
}

export class DAPClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private seq = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (value: DAPResponse) => void; reject: (error: Error) => void }
  >();
  private buffer = "";
  private capabilities: Capabilities = {};
  private currentThreadId: number | null = null;

  constructor(private netcoredbgPath: string = "netcoredbg") {
    super();
  }

  async start(): Promise<Capabilities> {
    this.process = spawn(this.netcoredbgPath, ["--interpreter=vscode"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.process.stdout!.on("data", (data: Buffer) => {
      this.handleData(data.toString());
    });

    this.process.stderr!.on("data", (data: Buffer) => {
      this.emit("stderr", data.toString());
    });

    this.process.on("close", (code) => {
      this.emit("close", code);
      this.cleanup();
    });

    this.process.on("error", (err) => {
      this.emit("error", err);
    });

    // Send initialize request
    const response = await this.sendRequest("initialize", {
      clientID: "mcp-netcoredbg",
      clientName: "MCP netcoredbg",
      adapterID: "coreclr",
      pathFormat: "path",
      linesStartAt1: true,
      columnsStartAt1: true,
      supportsRunInTerminalRequest: false,
    });

    this.capabilities = (response.body as Capabilities) || {};
    return this.capabilities;
  }

  private handleData(data: string): void {
    this.buffer += data;
    this.processBuffer();
  }

  private processBuffer(): void {
    while (true) {
      // Look for Content-Length header
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) break;

      const header = this.buffer.substring(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Invalid header, skip it
        this.buffer = this.buffer.substring(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.buffer.length < messageEnd) {
        // Not enough data yet
        break;
      }

      const messageText = this.buffer.substring(messageStart, messageEnd);
      this.buffer = this.buffer.substring(messageEnd);

      try {
        const message = JSON.parse(messageText) as DAPMessage;
        this.handleMessage(message);
      } catch (err) {
        this.emit("error", new Error(`Failed to parse DAP message: ${err}`));
      }
    }
  }

  private handleMessage(message: DAPMessage): void {
    if (message.type === "response") {
      const response = message as DAPResponse;
      const pending = this.pendingRequests.get(response.request_seq);
      if (pending) {
        this.pendingRequests.delete(response.request_seq);
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(
            new Error(response.message || `Request failed: ${response.command}`)
          );
        }
      }
    } else if (message.type === "event") {
      const event = message as DAPEvent;
      this.handleEvent(event);
    }
  }

  private handleEvent(event: DAPEvent): void {
    this.emit("event", event);
    this.emit(event.event, event.body);

    // Track current thread on stopped events
    if (event.event === "stopped") {
      const body = event.body as StoppedEventBody;
      if (body.threadId) {
        this.currentThreadId = body.threadId;
      }
    }
  }

  async sendRequest(command: string, args?: unknown): Promise<DAPResponse> {
    if (!this.process || !this.process.stdin) {
      throw new Error("DAP client not started");
    }

    const seq = this.seq++;
    const request: DAPRequest = {
      seq,
      type: "request",
      command,
      arguments: args,
    };

    const message = JSON.stringify(request);
    const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(seq, { resolve, reject });
      this.process!.stdin!.write(header + message);
    });
  }

  // High-level methods

  async launch(program: string, args?: string[], cwd?: string): Promise<void> {
    await this.sendRequest("launch", {
      program,
      args: args || [],
      cwd: cwd || process.cwd(),
      stopAtEntry: false,
      console: "internalConsole",
    });

    await this.sendRequest("configurationDone", {});
  }

  async attach(processId: number): Promise<void> {
    await this.sendRequest("attach", {
      processId,
    });

    await this.sendRequest("configurationDone", {});
  }

  async setBreakpoints(
    sourcePath: string,
    breakpoints: SourceBreakpoint[]
  ): Promise<Breakpoint[]> {
    const response = await this.sendRequest("setBreakpoints", {
      source: { path: sourcePath },
      breakpoints,
      sourceModified: false,
    });

    return (response.body as { breakpoints: Breakpoint[] }).breakpoints;
  }

  async removeBreakpoints(sourcePath: string): Promise<void> {
    await this.sendRequest("setBreakpoints", {
      source: { path: sourcePath },
      breakpoints: [],
    });
  }

  async continue(threadId?: number): Promise<void> {
    const tid = threadId || this.currentThreadId;
    if (!tid) {
      throw new Error("No thread ID available. Is the debugger stopped?");
    }
    await this.sendRequest("continue", { threadId: tid });
  }

  async stepOver(threadId?: number): Promise<void> {
    const tid = threadId || this.currentThreadId;
    if (!tid) {
      throw new Error("No thread ID available. Is the debugger stopped?");
    }
    await this.sendRequest("next", { threadId: tid });
  }

  async stepInto(threadId?: number): Promise<void> {
    const tid = threadId || this.currentThreadId;
    if (!tid) {
      throw new Error("No thread ID available. Is the debugger stopped?");
    }
    await this.sendRequest("stepIn", { threadId: tid });
  }

  async stepOut(threadId?: number): Promise<void> {
    const tid = threadId || this.currentThreadId;
    if (!tid) {
      throw new Error("No thread ID available. Is the debugger stopped?");
    }
    await this.sendRequest("stepOut", { threadId: tid });
  }

  async getThreads(): Promise<Thread[]> {
    const response = await this.sendRequest("threads", {});
    return (response.body as { threads: Thread[] }).threads;
  }

  async getStackTrace(
    threadId?: number,
    startFrame = 0,
    levels = 20
  ): Promise<StackFrame[]> {
    const tid = threadId || this.currentThreadId;
    if (!tid) {
      throw new Error("No thread ID available. Is the debugger stopped?");
    }

    const response = await this.sendRequest("stackTrace", {
      threadId: tid,
      startFrame,
      levels,
    });

    return (response.body as { stackFrames: StackFrame[] }).stackFrames;
  }

  async getScopes(frameId: number): Promise<Scope[]> {
    const response = await this.sendRequest("scopes", { frameId });
    return (response.body as { scopes: Scope[] }).scopes;
  }

  async getVariables(variablesReference: number): Promise<Variable[]> {
    const response = await this.sendRequest("variables", { variablesReference });
    return (response.body as { variables: Variable[] }).variables;
  }

  async evaluate(
    expression: string,
    frameId?: number,
    context: "watch" | "repl" | "hover" = "repl"
  ): Promise<{ result: string; type?: string; variablesReference: number }> {
    const response = await this.sendRequest("evaluate", {
      expression,
      frameId,
      context,
    });

    const body = response.body as {
      result: string;
      type?: string;
      variablesReference: number;
    };
    return body;
  }

  async pause(threadId?: number): Promise<void> {
    const tid = threadId || this.currentThreadId || 1;
    await this.sendRequest("pause", { threadId: tid });
  }

  async disconnect(terminateDebuggee = true): Promise<void> {
    try {
      await this.sendRequest("disconnect", { terminateDebuggee });
    } catch {
      // Ignore errors on disconnect
    }
    this.cleanup();
  }

  async terminate(): Promise<void> {
    if (this.capabilities.supportsTerminateRequest) {
      try {
        await this.sendRequest("terminate", {});
      } catch {
        // Fall back to disconnect
        await this.disconnect(true);
      }
    } else {
      await this.disconnect(true);
    }
  }

  private cleanup(): void {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("DAP client closed"));
    }
    this.pendingRequests.clear();
    this.currentThreadId = null;
  }

  isRunning(): boolean {
    return this.process !== null;
  }

  getCurrentThreadId(): number | null {
    return this.currentThreadId;
  }

  getCapabilities(): Capabilities {
    return this.capabilities;
  }
}
