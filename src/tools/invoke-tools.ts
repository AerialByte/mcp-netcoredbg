/**
 * Invoke tools - invoke a .NET method with or without debugging
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "path";
import * as fs from "fs";
import { sessionManager } from "../session-manager.js";
import { textResponse } from "./types.js";
import { sessionPrefix } from "../utils.js";
import { ensureHarnessBuilt, runHarness, harnessDll } from "../harness.js";

export function registerInvokeTools(server: McpServer): void {
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
      sessionId: z
        .string()
        .optional()
        .describe("Session ID for debug mode (auto-generated if not specified)"),
    },
    async ({ assembly, type, method, args, ctorArgs, debug, cwd, sessionId }) => {
      // Ensure harness is built
      const buildResult = await ensureHarnessBuilt();
      if (!buildResult.success) {
        return textResponse(buildResult.error || "Failed to build harness");
      }

      // Resolve assembly path
      const resolvedAssembly = path.isAbsolute(assembly)
        ? assembly
        : path.resolve(cwd || process.cwd(), assembly);

      if (!fs.existsSync(resolvedAssembly)) {
        return textResponse(`Assembly not found: ${resolvedAssembly}`);
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
        // Launch under debugger in a new session
        const derivedSessionId = sessionId || `invoke-${type.split(".").pop()}-${method}`;
        const session = sessionManager.createSession(derivedSessionId);

        try {
          await session.launch({
            program: harnessDll,
            args: [requestJson],
            cwd: cwd || path.dirname(resolvedAssembly),
            stopAtEntry: false,
          });

          return textResponse(
            `${sessionPrefix(session.id)}Invoking ${type}.${method} under debugger.\nSession ID: ${session.id}\nSet breakpoints in your source files, then use 'continue' to run.\nUse 'output' to see the result when complete.`
          );
        } catch (err) {
          await sessionManager.removeSession(session.id);
          throw err;
        }
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

            return textResponse(response);
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

            return textResponse(response);
          }
        } catch (err) {
          return textResponse(`Failed to run harness: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  );
}
