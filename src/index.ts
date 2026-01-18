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
  },
  async ({ program, args, cwd, stopAtEntry }) => {
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

    await dapClient.sendRequest("launch", {
      program,
      args: args || [],
      cwd: cwd || process.cwd(),
      stopAtEntry: stopAtEntry || false,
      console: "internalConsole",
    });

    await dapClient.sendRequest("configurationDone", {});

    return {
      content: [
        {
          type: "text" as const,
          text: `Debugger started for: ${program}\nCapabilities: ${Object.keys(capabilities).filter((k) => capabilities[k] === true).join(", ")}${stopAtEntry ? "\nStopped at entry point." : "\nProgram is running. Set breakpoints or pause to inspect."}`,
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

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
