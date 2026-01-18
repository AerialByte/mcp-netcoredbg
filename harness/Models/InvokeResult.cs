using System.Text.Json.Serialization;

namespace McpNetcoreDbg.Harness.Models;

public class InvokeResult
{
    [JsonPropertyName("success")]
    public bool Success { get; set; }

    [JsonPropertyName("method")]
    public string? Method { get; set; }

    [JsonPropertyName("args")]
    public object?[]? Args { get; set; }

    [JsonPropertyName("returnType")]
    public string? ReturnType { get; set; }

    [JsonPropertyName("returnValue")]
    public object? ReturnValue { get; set; }

    [JsonPropertyName("durationMs")]
    public double DurationMs { get; set; }

    [JsonPropertyName("logs")]
    public List<LogEntry>? Logs { get; set; }

    [JsonPropertyName("stdout")]
    public string? Stdout { get; set; }

    [JsonPropertyName("error")]
    public string? Error { get; set; }

    [JsonPropertyName("errorDetails")]
    public ErrorDetails? ErrorDetails { get; set; }
}

public class LogEntry
{
    [JsonPropertyName("level")]
    public string Level { get; set; } = "";

    [JsonPropertyName("message")]
    public string Message { get; set; } = "";

    [JsonPropertyName("category")]
    public string? Category { get; set; }
}

public class ErrorDetails
{
    [JsonPropertyName("type")]
    public string? Type { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }

    [JsonPropertyName("constructors")]
    public List<CtorSignature>? Constructors { get; set; }

    [JsonPropertyName("methods")]
    public List<MethodSignature>? Methods { get; set; }

    [JsonPropertyName("stackTrace")]
    public string? StackTrace { get; set; }
}

public class CtorSignature
{
    [JsonPropertyName("params")]
    public List<string> Params { get; set; } = new();
}

public class MethodSignature
{
    [JsonPropertyName("name")]
    public string Name { get; set; } = "";

    [JsonPropertyName("params")]
    public List<string> Params { get; set; } = new();

    [JsonPropertyName("returnType")]
    public string ReturnType { get; set; } = "";

    [JsonPropertyName("isStatic")]
    public bool IsStatic { get; set; }
}
