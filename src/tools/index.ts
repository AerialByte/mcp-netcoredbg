/**
 * Tool registration - exports all tool registration functions
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSessionTools } from "./session-tools.js";
import { registerLaunchTools } from "./launch-tools.js";
import { registerBreakpointTools } from "./breakpoint-tools.js";
import { registerExecutionTools } from "./execution-tools.js";
import { registerInspectionTools } from "./inspection-tools.js";
import { registerStatusTools } from "./status-tools.js";
import { registerLifecycleTools } from "./lifecycle-tools.js";
import { registerInvokeTools } from "./invoke-tools.js";

/**
 * Register all debugging tools with the MCP server.
 */
export function registerAllTools(server: McpServer): void {
  // Session management
  registerSessionTools(server);

  // Launch/attach
  registerLaunchTools(server);

  // Breakpoints
  registerBreakpointTools(server);

  // Execution control
  registerExecutionTools(server);

  // Inspection
  registerInspectionTools(server);

  // Status and output
  registerStatusTools(server);

  // Lifecycle
  registerLifecycleTools(server);

  // Invoke
  registerInvokeTools(server);
}
