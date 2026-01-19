/**
 * Status and output tools - output, status
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionManager } from "../session-manager.js";
import { sessionIdParam, textResponse } from "./types.js";
import { sessionPrefix, checkCodeStaleness } from "../utils.js";

export function registerStatusTools(server: McpServer): void {
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
      sessionId: sessionIdParam,
    },
    async ({ lines, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const output = session.getOutput(lines);

      if (output.length === 0) {
        return textResponse(`${sessionPrefix(session.id)}No output captured yet`);
      }

      return textResponse(`${sessionPrefix(session.id)}Program output:\n${output.join("")}`);
    }
  );

  // Tool: status
  server.tool(
    "status",
    "Get current debugger status (running, stopped, etc.)",
    {
      sessionId: sessionIdParam,
    },
    async ({ sessionId }) => {
      // If no sessionId provided and no sessions exist, show general status
      if (!sessionId && sessionManager.sessionCount() === 0) {
        let text = "No active debug sessions";

        const staleness = checkCodeStaleness();
        if (staleness.stale && staleness.message) {
          text += `\n\n${staleness.message}`;
        }

        return textResponse(text);
      }

      const session = sessionManager.getSession(sessionId);
      const status = session.getStatus();
      const config = session.getConfig();
      const watchState = session.getWatchState();

      let statusText = `${sessionPrefix(session.id)}Status: ${status.state}`;

      if (status.stoppedReason) {
        statusText += ` (${status.stoppedReason})`;
        if (status.stoppedThreadId) {
          statusText += ` on thread ${status.stoppedThreadId}`;
        }
      }

      statusText += `\nBreakpoints: ${status.breakpointCount}`;
      statusText += `\nOutput lines buffered: ${status.outputLineCount}`;

      if (config) {
        statusText += `\n\nSession Info:`;
        statusText += `\n  ID: ${session.id}`;
        statusText += `\n  Mode: ${config.mode}`;
        statusText += `\n  Program: ${config.program}`;
        if (config.launchProfile) {
          statusText += `\n  Launch Profile: ${config.launchProfile}`;
        }
        if (config.processId) {
          statusText += `\n  Process ID: ${config.processId}`;
        }
        if (config.cwd) {
          statusText += `\n  Working Dir: ${config.cwd}`;
        }
        const envKeys = Object.keys(config.resolvedEnv);
        if (envKeys.length > 0) {
          statusText += `\n  Env Vars: ${envKeys.join(", ")}`;
        }
        statusText += `\n  Uptime: ${status.uptime}s`;
      }

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

      return textResponse(statusText);
    }
  );
}
