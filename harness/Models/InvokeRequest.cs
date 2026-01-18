using System.Text.Json.Serialization;

namespace McpNetcoreDbg.Harness.Models;

public class InvokeRequest
{
    [JsonPropertyName("assembly")]
    public required string Assembly { get; set; }

    [JsonPropertyName("type")]
    public required string Type { get; set; }

    [JsonPropertyName("method")]
    public required string Method { get; set; }

    [JsonPropertyName("args")]
    public object?[]? Args { get; set; }

    [JsonPropertyName("ctorArgs")]
    public object?[]? CtorArgs { get; set; }
}
