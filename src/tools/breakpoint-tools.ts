/**
 * Breakpoint tools - set, remove, list breakpoints
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionManager } from "../session-manager.js";
import { sessionIdParam, textResponse } from "./types.js";
import { sessionPrefix } from "../utils.js";

export function registerBreakpointTools(server: McpServer): void {
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
      sessionId: sessionIdParam,
    },
    async ({ file, line, condition, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const result = await session.setBreakpoint(file, line, condition);

      if (result.verified) {
        return textResponse(
          `${sessionPrefix(session.id)}Breakpoint set at ${file}:${line}${condition ? ` (condition: ${condition})` : ""}`
        );
      } else {
        return textResponse(
          `${sessionPrefix(session.id)}Breakpoint at ${file}:${line} pending verification (${result.message || "source may not be loaded yet"})`
        );
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
      sessionId: sessionIdParam,
    },
    async ({ file, line, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      await session.removeBreakpoint(file, line);

      return textResponse(`${sessionPrefix(session.id)}Breakpoint removed from ${file}:${line}`);
    }
  );

  // Tool: list_breakpoints
  server.tool(
    "list_breakpoints",
    "List all active breakpoints",
    {
      sessionId: sessionIdParam,
    },
    async ({ sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const breakpoints = session.listBreakpoints();

      if (breakpoints.length === 0) {
        return textResponse(`${sessionPrefix(session.id)}No breakpoints set`);
      }

      const formatted = breakpoints.map((bp) => {
        const status = bp.verified ? "verified" : "pending";
        const source = bp.source?.path || "unknown";
        return `${source}:${bp.line} [${status}]`;
      });

      return textResponse(`${sessionPrefix(session.id)}Breakpoints:\n${formatted.join("\n")}`);
    }
  );
}
