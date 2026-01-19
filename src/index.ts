#!/usr/bin/env node

/**
 * mcp-netcoredbg - MCP server for .NET debugging via netcoredbg
 *
 * Provides debugging capabilities for .NET applications through the
 * Model Context Protocol (MCP). Supports multiple simultaneous debug
 * sessions, hot reload with dotnet watch, and comprehensive inspection.
 *
 * File structure:
 * - index.ts          - Server entry point (this file)
 * - session.ts        - DebugSession class (per-session state)
 * - session-manager.ts - SessionManager (multi-session coordination)
 * - dap-client.ts     - DAP protocol client
 * - harness.ts        - Method invocation harness
 * - utils.ts          - Utility functions
 * - tools/            - Tool definitions organized by category
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";

// Create MCP server
const server = new McpServer({
  name: "mcp-netcoredbg",
  version: "2.0.0", // Multi-session support
});

// Register all debugging tools
registerAllTools(server);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
