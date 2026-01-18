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

## Planned Tools

| Tool | Description |
|------|-------------|
| `launch` | Start debugger and attach to .NET process |
| `set_breakpoint` | Set breakpoint at file:line |
| `remove_breakpoint` | Remove a breakpoint |
| `list_breakpoints` | List all active breakpoints |
| `continue` | Continue execution |
| `step_over` | Step over current line |
| `step_into` | Step into function call |
| `step_out` | Step out of current function |
| `evaluate` | Evaluate expression / inspect variable |
| `stack_trace` | Get current call stack |
| `terminate` | Stop debugging session |

## Prerequisites

- [netcoredbg](https://github.com/Samsung/netcoredbg) installed
- Node.js 18+ (for MCP server)

## Status

🚧 **In Development**

## License

MIT
