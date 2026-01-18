# mcp-netcoredbg

MCP server for .NET debugging via [netcoredbg](https://github.com/Samsung/netcoredbg).

Enables AI agents (Claude, etc.) to set breakpoints, step through code, and inspect variables in .NET applications.

## Architecture

```
┌─────────┐     MCP      ┌─────────────────┐     DAP      ┌─────────────┐
│  Claude │ ──────────►  │ mcp-netcoredbg  │ ──────────►  │ netcoredbg  │
│         │  (tools)     │   (this repo)   │  (stdio)     │  (Samsung)  │
└─────────┘              └─────────────────┘              └──────┬──────┘
                                                                │
                                                                ▼
                                                         ┌─────────────┐
                                                         │  .NET App   │
                                                         └─────────────┘
```

## Tools

| Tool | Description |
|------|-------------|
| `launch` | Start debugging a .NET application (DLL path) |
| `attach` | Attach to a running .NET process |
| `set_breakpoint` | Set breakpoint at file:line (supports conditions) |
| `remove_breakpoint` | Remove a breakpoint |
| `list_breakpoints` | List all active breakpoints |
| `continue` | Continue execution |
| `pause` | Pause execution |
| `step_over` | Step over current line |
| `step_into` | Step into function call |
| `step_out` | Step out of current function |
| `stack_trace` | Get current call stack |
| `scopes` | Get variable scopes for a stack frame |
| `variables` | Get variables from a scope |
| `evaluate` | Evaluate expression in debug context |
| `threads` | List all threads |
| `output` | Get recent program output |
| `status` | Get debugger status |
| `terminate` | Stop debugging session |

## Prerequisites

- [netcoredbg](https://github.com/Samsung/netcoredbg) installed and in PATH
- Node.js 18+

## Installation

```bash
# Install netcoredbg (example for Linux x64)
curl -sLO https://github.com/Samsung/netcoredbg/releases/download/3.1.3-1062/netcoredbg-linux-amd64.tar.gz
tar xzf netcoredbg-linux-amd64.tar.gz
sudo mv netcoredbg /opt/netcoredbg
sudo ln -sf /opt/netcoredbg/netcoredbg /usr/local/bin/netcoredbg

# Build this MCP server
npm install
npm run build
```

## Usage with Claude Code

Add to your Claude Code MCP settings:

```json
{
  "mcpServers": {
    "netcoredbg": {
      "command": "node",
      "args": ["/path/to/mcp-netcoredbg/dist/index.js"]
    }
  }
}
```

## Security

This tool launches and controls a debugger. By design, it can:
- Execute arbitrary .NET applications
- Evaluate expressions within the debugged process
- Inspect memory and variables

Only use this with code you trust. Do not debug untrusted applications.

## Example Session

1. Build your .NET app with debug symbols: `dotnet build --configuration Debug`
2. Launch debugger: `launch` with the DLL path
3. Set breakpoints: `set_breakpoint` at file:line
4. Continue/step through code
5. Inspect variables with `scopes` and `variables`
6. Evaluate expressions with `evaluate`
7. Terminate when done

## License

MIT
