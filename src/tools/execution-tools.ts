/**
 * Execution control tools - continue, pause, step_over, step_into, step_out
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionManager } from "../session-manager.js";
import { sessionIdParam, textResponse } from "./types.js";
import { sessionPrefix } from "../utils.js";

export function registerExecutionTools(server: McpServer): void {
  // Tool: continue
  server.tool(
    "continue",
    "Continue program execution until next breakpoint or program end",
    {
      threadId: z
        .number()
        .optional()
        .describe("Thread ID to continue (defaults to current thread)"),
      sessionId: sessionIdParam,
    },
    async ({ threadId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      await session.continue(threadId);

      return textResponse(`${sessionPrefix(session.id)}Continuing execution...`);
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
      sessionId: sessionIdParam,
    },
    async ({ threadId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      await session.pause(threadId);

      return textResponse(`${sessionPrefix(session.id)}Execution paused`);
    }
  );

  // Tool: step_over
  server.tool(
    "step_over",
    "Step over the current line (execute it without stepping into functions)",
    {
      threadId: z.number().optional().describe("Thread ID"),
      sessionId: sessionIdParam,
    },
    async ({ threadId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      await session.stepOver(threadId);

      return textResponse(`${sessionPrefix(session.id)}Stepped over`);
    }
  );

  // Tool: step_into
  server.tool(
    "step_into",
    "Step into the function call on the current line",
    {
      threadId: z.number().optional().describe("Thread ID"),
      sessionId: sessionIdParam,
    },
    async ({ threadId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      await session.stepInto(threadId);

      return textResponse(`${sessionPrefix(session.id)}Stepped into`);
    }
  );

  // Tool: step_out
  server.tool(
    "step_out",
    "Step out of the current function",
    {
      threadId: z.number().optional().describe("Thread ID"),
      sessionId: sessionIdParam,
    },
    async ({ threadId, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      await session.stepOut(threadId);

      return textResponse(`${sessionPrefix(session.id)}Stepped out`);
    }
  );
}
