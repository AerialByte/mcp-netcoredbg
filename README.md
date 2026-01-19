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
| `launch_watch` | **Start debugging with hot reload** via `dotnet watch` |
| `stop_watch` | Stop hot reload debugging mode |
| `attach` | Attach to a running .NET process |
| `invoke` | **Invoke a specific method** in an assembly (with optional debugging) |
| `restart` | Restart the debugged program (for `launch` mode) |
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

## Method Invocation (`invoke`)

The `invoke` tool lets you run a specific method from a .NET assembly without launching the full application. This is useful for:

- Testing individual methods in isolation
- Running utility functions
- Debugging specific code paths without going through the whole app

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `assembly` | string | Yes | Path to the .NET DLL |
| `type` | string | Yes | Fully qualified type name (e.g., `MyApp.Services.Calculator`) |
| `method` | string | Yes | Method name to invoke |
| `args` | array | No | Method arguments as JSON array |
| `ctorArgs` | array | No | Constructor arguments (for instance methods) |
| `debug` | boolean | No | Launch under debugger for breakpoint support (default: false) |
| `cwd` | string | No | Working directory |

### Examples

**Static method:**
```json
{
  "assembly": "/path/to/MyApp.dll",
  "type": "MyApp.StringUtils",
  "method": "FormatName",
  "args": ["John", "Doe"]
}
```

**Instance method with constructor arguments:**
```json
{
  "assembly": "/path/to/MyApp.dll",
  "type": "MyApp.Calculator",
  "method": "Add",
  "args": [5],
  "ctorArgs": [10]
}
```

**With debugging (breakpoints supported):**
```json
{
  "assembly": "/path/to/MyApp.dll",
  "type": "MyApp.Calculator",
  "method": "Add",
  "args": [5],
  "debug": true
}
```

### Features

- **Static methods**: Just provide type, method, and args
- **Instance methods**: Automatically constructs the type (provide `ctorArgs` if needed)
- **Auto ILogger injection**: `ILogger<T>` parameters are automatically resolved
- **Async support**: Automatically awaits Task-returning methods
- **Console capture**: Captures `Console.WriteLine` output
- **Log capture**: Captures `ILogger` calls made during execution
- **Rich errors**: On failure, shows available constructors/methods to help you fix the call

### Output Format

The tool returns a structured JSON result:

```json
{
  "success": true,
  "method": "MyApp.StringUtils.FormatName",
  "args": ["John", "Doe"],
  "returnType": "string",
  "returnValue": "Doe, John",
  "durationMs": 2.5,
  "logs": [
    {"level": "Information", "message": "Processing..."}
  ],
  "stdout": ""
}
```

On error, it provides helpful diagnostics:

```json
{
  "success": false,
  "error": "Method not found",
  "errorDetails": {
    "type": "MyApp.StringUtils",
    "reason": "Method 'DoSomething' not found",
    "methods": [
      {"name": "FormatName", "params": ["string firstName", "string lastName"], "returnType": "string", "isStatic": true}
    ]
  }
}
```

## Hot Reload Debugging (`launch_watch`)

The `launch_watch` tool enables debugging with hot reload support via `dotnet watch`. When you make code changes, the app automatically restarts and the debugger reconnects - preserving your breakpoints.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `projectPath` | string | Yes | Path to the .NET project directory (containing .csproj) |
| `launchProfile` | string | No | Name of a launch profile from `Properties/launchSettings.json` |
| `args` | array | No | Additional arguments to pass to `dotnet watch` |

### Examples

**Basic usage:**
```json
{
  "projectPath": "/path/to/MyApp"
}
```

**With launch profile (recommended for ASP.NET apps):**
```json
{
  "projectPath": "/path/to/MyApp.Api",
  "launchProfile": "https"
}
```

The launch profile is important for ASP.NET applications as it sets:
- `ASPNETCORE_ENVIRONMENT` (e.g., Development)
- `applicationUrl` (e.g., https://localhost:7179)
- Other environment variables needed for proper operation

### How It Works

1. Starts `dotnet watch run` with the specified project
2. Waits for the app to build and start
3. Automatically attaches the debugger to the running process
4. When you edit code and save, `dotnet watch` rebuilds and restarts
5. The debugger detects the restart and reconnects automatically
6. Breakpoints are preserved across restarts

### Stopping Hot Reload Mode

Use `stop_watch` to cleanly terminate both the debugger and the `dotnet watch` process.

### Status Information

Use `status` to see hot reload specific information:
- Watch process PID
- Child app PID
- Whether the debugger is currently reconnecting

## Prerequisites

- [netcoredbg](https://github.com/Samsung/netcoredbg) installed and in PATH
- Node.js 18+
- .NET SDK 8.0+ (for building the harness and target applications)

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

# The method invocation harness is auto-built on first use
```

## Usage with Claude Code

**Quick install:**
```bash
# Clone and build
git clone https://github.com/AerialByte/mcp-netcoredbg.git
cd mcp-netcoredbg && npm install && npm run build

# Add to Claude Code
claude mcp add netcoredbg -- node $(pwd)/dist/index.js
```

**Or manually** add to your Claude Code MCP settings:

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

### Full Application Debugging

1. Build your .NET app with debug symbols: `dotnet build --configuration Debug`
2. Launch debugger: `launch` with the DLL path
3. Set breakpoints: `set_breakpoint` at file:line
4. Continue/step through code
5. Inspect variables with `scopes` and `variables`
6. Evaluate expressions with `evaluate`
7. Terminate when done

### Method Invocation (Quick Testing)

1. Build the target assembly: `dotnet build`
2. Use `invoke` with the type and method name
3. If it fails, check the error for available constructors/methods
4. For debugging: set breakpoints first, then use `invoke` with `debug: true`

## Agent Guidelines

When using this MCP server as an AI agent:

### Choosing Between `launch` and `invoke`

- Use **`invoke`** when you want to test a specific method in isolation
- Use **`launch`** when you need to run the full application or debug complex scenarios

### Using `invoke` Effectively

1. **Start simple**: Try without `ctorArgs` first - the harness will use parameterless constructors or auto-inject `ILogger<T>`

2. **Handle errors iteratively**: If invocation fails, the error response includes available methods/constructors. Use this to correct your call.

3. **For debugging specific methods**:
   ```
   1. Set breakpoints in the source files first
   2. Call invoke with debug: true
   3. Use continue/step_over/step_into to navigate
   4. Use output to see the final result
   ```

4. **Arguments are JSON**: Pass args as a JSON array. The harness handles type conversion:
   - Strings: `"hello"`
   - Numbers: `42`, `3.14`
   - Booleans: `true`, `false`
   - Null: `null`
   - Objects: `{"name": "Alice", "age": 30}`

### Common Patterns

**Testing a utility method:**
```
invoke assembly=/path/to.dll type=MyApp.Utils method=Parse args=["input"]
```

**Testing with constructor injection:**
```
invoke assembly=/path/to.dll type=MyApp.Service method=Process ctorArgs=[100] args=["data"]
```

**Debugging a failing method:**
```
1. set_breakpoint file=/path/to/Service.cs line=42
2. invoke assembly=/path/to.dll type=MyApp.Service method=Process args=["bad-input"] debug=true
3. (breakpoint hits)
4. variables variablesReference=1
5. continue
6. output
```

## License

MIT
