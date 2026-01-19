/**
 * Lifecycle tools - terminate, restart
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionManager } from "../session-manager.js";
import { sessionIdParam, textResponse } from "./types.js";
import { sessionPrefix } from "../utils.js";

export function registerLifecycleTools(server: McpServer): void {
  // Tool: terminate
  server.tool(
    "terminate",
    "Stop the debug session and terminate the debugged program",
    {
      sessionId: sessionIdParam,
    },
    async ({ sessionId }) => {
      try {
        const session = sessionManager.getSession(sessionId);
        const id = session.id;

        await sessionManager.removeSession(id);

        return textResponse(`Debug session '${id}' terminated`);
      } catch (err) {
        return textResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Tool: restart
  server.tool(
    "restart",
    "Restart the debugged program using the same launch settings. Useful after code changes.",
    {
      rebuild: z.boolean().optional().default(false).describe("Run 'dotnet build' before restarting (for code changes)"),
      sessionId: sessionIdParam,
    },
    async ({ rebuild, sessionId }) => {
      const session = sessionManager.getSession(sessionId);
      const config = session.getConfig();

      if (!config || config.mode !== "launch") {
        return textResponse(
          `${sessionPrefix(session.id)}Cannot restart - session is not in launch mode. Use 'launch' to start a debug session.`
        );
      }

      try {
        await session.restart(rebuild);

        let statusMsg = `${sessionPrefix(session.id)}Restarted: ${config.program}`;
        if (rebuild) {
          statusMsg += "\n(Rebuilt before restart)";
        }
        if (config.launchProfile) {
          statusMsg += `\nUsing launch profile: ${config.launchProfile}`;
        }
        statusMsg += "\nProgram is running. Set breakpoints or pause to inspect.";

        return textResponse(statusMsg);
      } catch (err) {
        return textResponse(
          `${sessionPrefix(session.id)}Restart failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  );
}
