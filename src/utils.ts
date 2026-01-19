/**
 * Utility functions for mcp-netcoredbg
 */

import * as path from "path";
import * as fs from "fs";
import { StackFrame, Variable } from "./dap-client.js";
import { sessionManager } from "./session-manager.js";

/**
 * Check if source code is newer than compiled code.
 * Helps users know when they need to rebuild.
 */
export function checkCodeStaleness(): { stale: boolean; message?: string } {
  try {
    const compiledPath = new URL(import.meta.url).pathname;
    const srcDir = path.resolve(path.dirname(compiledPath), "..", "src");
    const sourcePath = path.join(srcDir, "index.ts");

    if (!fs.existsSync(sourcePath)) {
      return { stale: false };
    }

    const compiledStat = fs.statSync(compiledPath);
    const sourceStat = fs.statSync(sourcePath);

    if (sourceStat.mtimeMs > compiledStat.mtimeMs) {
      const diffMs = sourceStat.mtimeMs - compiledStat.mtimeMs;
      const diffMins = Math.round(diffMs / 60000);
      return {
        stale: true,
        message: `⚠️ Source code is ${diffMins > 0 ? diffMins + " minute(s)" : "seconds"} newer than compiled code. Run 'npm run build' and restart MCP server to pick up changes.`,
      };
    }

    return { stale: false };
  } catch {
    return { stale: false };
  }
}

/**
 * Format a stack frame for display.
 */
export function formatStackFrame(frame: StackFrame): string {
  const location = frame.source?.path
    ? `${frame.source.path}:${frame.line}`
    : frame.source?.name || "unknown";
  return `#${frame.id} ${frame.name} at ${location}`;
}

/**
 * Format a variable for display with optional indentation.
 */
export function formatVariable(v: Variable, indent = 0): string {
  const prefix = "  ".repeat(indent);
  const type = v.type ? ` (${v.type})` : "";
  return `${prefix}${v.name}${type} = ${v.value}`;
}

/**
 * Format session prefix for multi-session output clarity.
 * Only shows prefix when there are multiple active sessions.
 */
export function sessionPrefix(sessionId: string): string {
  return sessionManager.sessionCount() > 1 ? `[${sessionId}] ` : "";
}
