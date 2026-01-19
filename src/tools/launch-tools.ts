/**
 * Launch tools - launch, attach, launch_watch, stop_watch
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionManager } from "../session-manager.js";
import { sessionIdParam, textResponse } from "./types.js";
import { sessionPrefix } from "../utils.js";

export function registerLaunchTools(server: McpServer): void {
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
      sessionId: z
        .string()
        .optional()
        .describe("Session ID for this debug session (auto-generated from program name if not specified)"),
    },
    async ({ program, args, cwd, stopAtEntry, env, launchProfile, sessionId }) => {
      // Derive session ID from program if not specified
      const derivedSessionId = sessionId || sessionManager.deriveSessionIdFromProgram(program);

      // Create new session
      const session = sessionManager.createSession(derivedSessionId);

      try {
        const { capabilities, resolvedEnv } = await session.launch({
          program,
          args,
          cwd,
          stopAtEntry,
          env,
          launchProfile,
        });

        // Build status message
        let statusMsg = `${sessionPrefix(session.id)}Debugger started for: ${program}`;
        statusMsg += `\nSession ID: ${session.id}`;
        statusMsg += `\nCapabilities: ${Object.keys(capabilities).filter((k) => capabilities[k] === true).join(", ")}`;

        if (launchProfile) {
          statusMsg += `\nUsing launch profile: ${launchProfile}`;
        }

        if (Object.keys(resolvedEnv).length > 0) {
          statusMsg += `\nEnvironment variables: ${Object.keys(resolvedEnv).join(", ")}`;
        }

        statusMsg += stopAtEntry
          ? "\nStopped at entry point."
          : "\nProgram is running. Set breakpoints or pause to inspect.";

        return textResponse(statusMsg);
      } catch (err) {
        // Clean up failed session
        await sessionManager.removeSession(session.id);
        throw err;
      }
    }
  );

  // Tool: attach
  server.tool(
    "attach",
    "Attach debugger to a running .NET process",
    {
      processId: z.number().describe("Process ID to attach to"),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID for this debug session (auto-generated if not specified)"),
    },
    async ({ processId, sessionId }) => {
      // Derive session ID if not specified
      const derivedSessionId = sessionId || `process-${processId}`;

      const session = sessionManager.createSession(derivedSessionId);

      try {
        await session.attach(processId);
        return textResponse(`${sessionPrefix(session.id)}Attached to process ${processId}\nSession ID: ${session.id}`);
      } catch (err) {
        await sessionManager.removeSession(session.id);
        throw err;
      }
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
      noHotReload: z
        .boolean()
        .optional()
        .default(false)
        .describe("Disable in-process hot reload, forcing full restarts on every change. Use this for reliable debugging of async methods."),
      sessionId: z
        .string()
        .optional()
        .describe("Session ID for this debug session (auto-generated from project name if not specified)"),
    },
    async ({ projectPath, launchProfile, args, noHotReload, sessionId }) => {
      // Derive session ID from project path if not specified
      const derivedSessionId = sessionId || sessionManager.deriveSessionIdFromPath(projectPath);

      const session = sessionManager.createSession(derivedSessionId);

      try {
        const { watchPid, childPid } = await session.launchWatch({
          projectPath,
          launchProfile,
          args,
          noHotReload,
        });

        let statusMsg = `${sessionPrefix(session.id)}Hot reload debugging started`;
        statusMsg += `\nSession ID: ${session.id}`;
        statusMsg += `\nProject: ${projectPath}`;
        statusMsg += `\nWatch process PID: ${watchPid}`;
        statusMsg += `\nAttached to process: ${childPid}`;
        if (launchProfile) {
          statusMsg += `\nLaunch profile: ${launchProfile}`;
        }
        if (noHotReload) {
          statusMsg += `\nMode: Full restart on changes (--no-hot-reload)`;
        }
        statusMsg += `\n\nThe debugger will automatically reconnect when the app restarts after code changes.`;
        statusMsg += `\nUse 'stop_watch' to stop hot reload mode.`;

        return textResponse(statusMsg);
      } catch (err) {
        await sessionManager.removeSession(session.id);
        return textResponse(`Failed to start watch mode: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );

  // Tool: stop_watch - Stop hot reload mode
  server.tool(
    "stop_watch",
    "Stop hot reload debugging mode and terminate the dotnet watch process",
    {
      sessionId: sessionIdParam,
    },
    async ({ sessionId }) => {
      try {
        const session = sessionManager.getSession(sessionId);

        if (!session.isWatchMode()) {
          return textResponse(`${sessionPrefix(session.id)}Session is not in watch mode`);
        }

        await session.stopWatch();
        await sessionManager.removeSession(session.id);

        return textResponse(`${sessionPrefix(session.id)}Hot reload debugging stopped`);
      } catch (err) {
        return textResponse(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
