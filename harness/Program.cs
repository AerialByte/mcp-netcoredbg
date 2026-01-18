using System.Text;
using System.Text.Json;
using McpNetcoreDbg.Harness;
using McpNetcoreDbg.Harness.Models;

// Capture stdout
var stdoutCapture = new StringBuilder();
var originalStdout = Console.Out;
Console.SetOut(new StringWriter(stdoutCapture));

try
{
    // Parse command line - expect JSON as first argument or via stdin
    InvokeRequest? request = null;

    if (args.Length > 0)
    {
        // JSON passed as argument
        var json = args[0];
        request = JsonSerializer.Deserialize<InvokeRequest>(json);
    }
    else
    {
        // Read from stdin
        Console.SetOut(originalStdout);
        var json = Console.In.ReadToEnd();
        request = JsonSerializer.Deserialize<InvokeRequest>(json);
    }

    if (request == null)
    {
        WriteError("Invalid request: could not parse JSON");
        return 1;
    }

    // Create logger provider and invoker
    var loggerProvider = new CapturingLoggerProvider();
    var invoker = new MethodInvoker(loggerProvider);

    // Invoke the method
    var result = invoker.Invoke(request);

    // Restore stdout and add captured output
    Console.SetOut(originalStdout);
    result.Stdout = stdoutCapture.ToString();

    // Output result as JSON
    var output = JsonSerializer.Serialize(result, new JsonSerializerOptions
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    });

    Console.WriteLine(output);

    return result.Success ? 0 : 1;
}
catch (Exception ex)
{
    Console.SetOut(originalStdout);
    WriteError($"Harness error: {ex.Message}", ex.StackTrace);
    return 1;
}

void WriteError(string message, string? stackTrace = null)
{
    var result = new InvokeResult
    {
        Success = false,
        Error = message,
        ErrorDetails = stackTrace != null ? new ErrorDetails { StackTrace = stackTrace } : null,
        Stdout = stdoutCapture.ToString()
    };

    var output = JsonSerializer.Serialize(result, new JsonSerializerOptions
    {
        WriteIndented = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    });

    Console.WriteLine(output);
}
