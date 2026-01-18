using Microsoft.Extensions.Logging;
using McpNetcoreDbg.Harness.Models;

namespace McpNetcoreDbg.Harness;

public class CapturingLogger : ILogger
{
    private readonly string _categoryName;
    private readonly CapturingLoggerProvider _provider;

    public CapturingLogger(string categoryName, CapturingLoggerProvider provider)
    {
        _categoryName = categoryName;
        _provider = provider;
    }

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        var message = formatter(state, exception);
        if (exception != null)
        {
            message += Environment.NewLine + exception.ToString();
        }

        _provider.AddLog(new LogEntry
        {
            Level = logLevel.ToString(),
            Message = message,
            Category = _categoryName
        });
    }
}

public class CapturingLoggerProvider : ILoggerProvider
{
    private readonly List<LogEntry> _logs = new();
    private readonly object _lock = new();

    public ILogger CreateLogger(string categoryName)
    {
        return new CapturingLogger(categoryName, this);
    }

    public void AddLog(LogEntry entry)
    {
        lock (_lock)
        {
            _logs.Add(entry);
        }
    }

    public List<LogEntry> GetLogs()
    {
        lock (_lock)
        {
            return new List<LogEntry>(_logs);
        }
    }

    public void Dispose() { }
}

public class CapturingLoggerFactory : ILoggerFactory
{
    private readonly CapturingLoggerProvider _provider;

    public CapturingLoggerFactory(CapturingLoggerProvider provider)
    {
        _provider = provider;
    }

    public void AddProvider(ILoggerProvider provider) { }

    public ILogger CreateLogger(string categoryName)
    {
        return _provider.CreateLogger(categoryName);
    }

    public void Dispose() { }
}
