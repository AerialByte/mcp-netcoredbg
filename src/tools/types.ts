/**
 * Shared types and schemas for tools
 */

import { z } from "zod";

/**
 * Session ID parameter schema - used by all debugging tools.
 * Optional, defaults to current session.
 */
export const sessionIdParam = z
  .string()
  .optional()
  .describe("Session ID (defaults to current session). Use list_sessions to see available sessions.");

/**
 * Create a simple text response for tool callbacks.
 * Returns the proper format expected by the MCP SDK.
 */
export function textResponse(text: string) {
  return {
    content: [
      {
        type: "text" as const,
        text,
      },
    ],
  };
}
