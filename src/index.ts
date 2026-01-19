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

// State
let dapClient: DAPClient | null = null;
const breakpointsByFile = new Map<string, Map<number, Breakpoint>>();
const outputBuffer: string[] = [];
let lastStoppedReason: string | null = null;
let lastStoppedThreadId: number | null = null;

// Create MCP server
const server = new McpServer({
  name: "mcp-netcoredbg",
  version: "1.0.0",
});

// Helper functions
function requireDebugger(): DAPClient {
  if (!dapClient || !dapClient.isRunning()) {
    throw new Error(
      "Debugger not running. Use 'launch' to start a debug session."
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
      return {
        content: [
          {
            type: "text" as const,
            text: "Debugger not running",
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

    return {
      content: [
        {
          type: "text" as const,
          text: `Status: ${status}\nBreakpoints: ${bpCount}\nOutput lines buffered: ${outputBuffer.length}`,
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

// Tool: invoke
import { spawn, spawnSync } from "child_process";

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
