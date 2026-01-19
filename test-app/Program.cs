// Simple test application for hot reload debugging

var counter = 0;

Console.WriteLine("Hot Reload Test Application");
Console.WriteLine("Press Ctrl+C to exit");
Console.WriteLine();

while (true)
{
    counter++;
    var message = GetMessage(counter);
    Console.WriteLine(message);
    await Task.Delay(2000);
}

static string GetMessage(int count)
{
    // This is a good place to set a breakpoint
    return $"[{DateTime.Now:HH:mm:ss}] Count: {count}";
}
