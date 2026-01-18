using Microsoft.Extensions.Logging;

namespace TestLib;

public static class StringUtils
{
    public static string FormatName(string firstName, string lastName)
    {
        return $"{lastName}, {firstName}";
    }

    public static int Add(int a, int b)
    {
        return a + b;
    }

    public static string Greet(string name)
    {
        Console.WriteLine($"Greeting {name}...");
        return $"Hello, {name}!";
    }
}

public class Calculator
{
    private readonly int _initialValue;
    private readonly ILogger<Calculator>? _logger;

    public Calculator()
    {
        _initialValue = 0;
    }

    public Calculator(int initialValue)
    {
        _initialValue = initialValue;
    }

    public Calculator(ILogger<Calculator> logger)
    {
        _logger = logger;
        _initialValue = 0;
    }

    public Calculator(int initialValue, ILogger<Calculator> logger)
    {
        _initialValue = initialValue;
        _logger = logger;
    }

    public int Add(int value)
    {
        _logger?.LogInformation("Adding {Value} to {Initial}", value, _initialValue);
        var result = _initialValue + value;
        _logger?.LogInformation("Result: {Result}", result);
        return result;
    }

    public int Multiply(int value)
    {
        _logger?.LogInformation("Multiplying {Initial} by {Value}", _initialValue, value);
        return _initialValue * value;
    }
}

public class Person
{
    public string Name { get; set; } = "";
    public int Age { get; set; }

    public override string ToString() => $"{Name} ({Age})";
}

public static class PersonService
{
    public static Person CreatePerson(string name, int age)
    {
        return new Person { Name = name, Age = age };
    }

    public static string Describe(Person person)
    {
        return $"{person.Name} is {person.Age} years old";
    }
}

public static class AsyncExamples
{
    public static async Task<string> FetchDataAsync(string url)
    {
        await Task.Delay(100);
        return $"Data from {url}";
    }

    public static async Task<int> ComputeAsync(int value)
    {
        await Task.Delay(50);
        return value * 2;
    }
}
