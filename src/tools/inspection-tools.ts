/**
 * Inspection tools - stack_trace, scopes, variables, evaluate, threads
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Variable } from "../dap-client.js";
import { sessionManager } from "../session-manager.js";
import { sessionIdParam, textResponse } from "./types.js";
import { sessionPrefix, formatStackFrame, formatVariable } from "../utils.js";

export function registerInspectionTools(server: McpServer): void {
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
      sessionId: sessionIdParam,
    },
    async ({ threadId, depth, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const frames = await session.getStackTrace(threadId, depth);

      if (frames.length === 0) {
        return textResponse(
          `${sessionPrefix(session.id)}No stack frames available. Is the program stopped?`
        );
      }

      const formatted = frames.map(formatStackFrame).join("\n");

      return textResponse(`${sessionPrefix(session.id)}Call Stack:\n${formatted}`);
    }
  );

  // Tool: scopes
  server.tool(
    "scopes",
    "Get variable scopes for a stack frame",
    {
      frameId: z.number().describe("Stack frame ID (from stack_trace)"),
      sessionId: sessionIdParam,
    },
    async ({ frameId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const scopes = await session.getScopes(frameId);

      const lines = scopes.map(
        (s) => `${s.name} (ref: ${s.variablesReference}, expensive: ${s.expensive})`
      );

      return textResponse(`${sessionPrefix(session.id)}Scopes:\n${lines.join("\n")}`);
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
      sessionId: sessionIdParam,
    },
    async ({ variablesReference, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const vars = await session.getVariables(variablesReference);

      if (vars.length === 0) {
        return textResponse(`${sessionPrefix(session.id)}No variables in this scope`);
      }

      const lines = vars.map((v) => formatVariable(v, 0));

      return textResponse(`${sessionPrefix(session.id)}Variables:\n${lines.join("\n")}`);
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
      sessionId: sessionIdParam,
    },
    async ({ expression, frameId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const result = await session.evaluate(expression, frameId);

      const type = result.type ? ` (${result.type})` : "";
      return textResponse(`${sessionPrefix(session.id)}${expression}${type} = ${result.result}`);
    }
  );

  // Tool: threads
  server.tool(
    "threads",
    "List all threads in the debugged process",
    {
      sessionId: sessionIdParam,
    },
    async ({ sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const threads = await session.getThreads();

      const lines = threads.map((t) => `  Thread ${t.id}: ${t.name}`);

      return textResponse(`${sessionPrefix(session.id)}Threads:\n${lines.join("\n")}`);
    }
  );
}
