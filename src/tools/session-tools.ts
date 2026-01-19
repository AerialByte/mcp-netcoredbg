/**
 * Session management tools - list, select, terminate sessions
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionManager } from "../session-manager.js";
import { textResponse } from "./types.js";

export function registerSessionTools(server: McpServer): void {
  // Tool: list_sessions
  server.tool(
    "list_sessions",
    "List all active debug sessions with their status",
    {},
    async () => {
      const sessions = sessionManager.listSessions();

      if (sessions.length === 0) {
        return textResponse("No active debug sessions. Use 'launch' or 'launch_watch' to start one.");
      }

      const lines = sessions.map((s) => {
        const defaultMarker = s.isDefault ? " (default)" : "";
        const status = s.status.state;
        const info = s.status.stoppedReason ? ` - ${s.status.stoppedReason}` : "";
        return `${s.id}${defaultMarker}: ${s.mode} - ${s.program} [${status}${info}]`;
      });

      return textResponse(`Active Sessions:\n${lines.join("\n")}`);
    }
  );

  // Tool: select_session
  server.tool(
    "select_session",
    "Set the default session for subsequent commands",
    {
      sessionId: z.string().describe("Session ID to make default"),
    },
    async ({ sessionId }) => {
      try {
        sessionManager.setDefaultSession(sessionId);
        return textResponse(`Default session set to: ${sessionId}`);
      } catch (err) {
        return textResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Tool: terminate_session
  server.tool(
    "terminate_session",
    "Terminate a specific debug session",
    {
      sessionId: z.string().describe("Session ID to terminate"),
    },
    async ({ sessionId }) => {
      try {
        await sessionManager.removeSession(sessionId);
        return textResponse(`Session '${sessionId}' terminated`);
      } catch (err) {
        return textResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
