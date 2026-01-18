using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using McpNetcoreDbg.Harness.Models;

namespace McpNetcoreDbg.Harness;

public class MethodInvoker
{
    private readonly CapturingLoggerProvider _loggerProvider;
    private readonly IServiceProvider _serviceProvider;

    public MethodInvoker(CapturingLoggerProvider loggerProvider)
    {
        _loggerProvider = loggerProvider;

        var services = new ServiceCollection();
        services.AddSingleton<ILoggerFactory>(new CapturingLoggerFactory(loggerProvider));
        services.AddSingleton(typeof(ILogger<>), typeof(Logger<>));
        _serviceProvider = services.BuildServiceProvider();
    }

    public InvokeResult Invoke(InvokeRequest request)
    {
        var result = new InvokeResult
        {
            Args = request.Args
        };

        var stopwatch = Stopwatch.StartNew();

        try
        {
            // Load assembly
            var assemblyPath = Path.GetFullPath(request.Assembly);
            if (!File.Exists(assemblyPath))
            {
                return Fail(result, "Assembly not found", new ErrorDetails
                {
                    Reason = $"File not found: {assemblyPath}"
                });
            }

            var assembly = Assembly.LoadFrom(assemblyPath);

            // Find type
            var type = assembly.GetType(request.Type);
            if (type == null)
            {
                var availableTypes = assembly.GetTypes()
                    .Where(t => t.IsPublic && !t.IsAbstract)
                    .Select(t => t.FullName)
                    .Take(20)
                    .ToList();

                return Fail(result, "Type not found", new ErrorDetails
                {
                    Type = request.Type,
                    Reason = $"Type '{request.Type}' not found in assembly",
                    Methods = availableTypes.Select(t => new MethodSignature { Name = t ?? "" }).ToList()
                });
            }

            // Find method
            var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance)
                .Where(m => m.Name == request.Method)
                .ToList();

            if (methods.Count == 0)
            {
                var availableMethods = type.GetMethods(BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance)
                    .Where(m => !m.IsSpecialName)
                    .Select(m => new MethodSignature
                    {
                        Name = m.Name,
                        Params = m.GetParameters().Select(p => $"{GetFriendlyTypeName(p.ParameterType)} {p.Name}").ToList(),
                        ReturnType = GetFriendlyTypeName(m.ReturnType),
                        IsStatic = m.IsStatic
                    })
                    .ToList();

                return Fail(result, "Method not found", new ErrorDetails
                {
                    Type = request.Type,
                    Reason = $"Method '{request.Method}' not found on type '{request.Type}'",
                    Methods = availableMethods
                });
            }

            // Try to find matching overload
            var argCount = request.Args?.Length ?? 0;
            var method = methods.FirstOrDefault(m => m.GetParameters().Length == argCount)
                ?? methods.First();

            result.Method = $"{request.Type}.{method.Name}";

            // Prepare arguments
            var parameters = method.GetParameters();
            var convertedArgs = ConvertArguments(parameters, request.Args);

            // Create instance if needed
            object? instance = null;
            if (!method.IsStatic)
            {
                instance = CreateInstance(type, request.CtorArgs);
            }

            // Invoke method
            var returnValue = method.Invoke(instance, convertedArgs);

            // Handle async methods
            if (returnValue is Task task)
            {
                task.GetAwaiter().GetResult();

                var taskType = task.GetType();
                if (taskType.IsGenericType)
                {
                    var resultProperty = taskType.GetProperty("Result");
                    returnValue = resultProperty?.GetValue(task);
                }
                else
                {
                    returnValue = null;
                }
            }

            stopwatch.Stop();

            result.Success = true;
            result.ReturnType = GetFriendlyTypeName(method.ReturnType);
            result.ReturnValue = SerializeValue(returnValue);
            result.DurationMs = stopwatch.Elapsed.TotalMilliseconds;
            result.Logs = _loggerProvider.GetLogs();

            return result;
        }
        catch (TargetInvocationException ex)
        {
            stopwatch.Stop();
            result.DurationMs = stopwatch.Elapsed.TotalMilliseconds;
            result.Logs = _loggerProvider.GetLogs();

            var inner = ex.InnerException ?? ex;
            return Fail(result, $"Method threw exception: {inner.Message}", new ErrorDetails
            {
                Reason = inner.Message,
                StackTrace = inner.StackTrace
            });
        }
        catch (Exception ex)
        {
            stopwatch.Stop();
            result.DurationMs = stopwatch.Elapsed.TotalMilliseconds;
            result.Logs = _loggerProvider.GetLogs();

            return Fail(result, ex.Message, new ErrorDetails
            {
                Reason = ex.Message,
                StackTrace = ex.StackTrace
            });
        }
    }

    private object? CreateInstance(Type type, object?[]? ctorArgs)
    {
        var constructors = type.GetConstructors();

        // Try parameterless constructor first
        if ((ctorArgs == null || ctorArgs.Length == 0) && constructors.Any(c => c.GetParameters().Length == 0))
        {
            return Activator.CreateInstance(type);
        }

        // Try to find matching constructor
        var argCount = ctorArgs?.Length ?? 0;
        var ctor = constructors.FirstOrDefault(c => c.GetParameters().Length == argCount);

        if (ctor != null)
        {
            var parameters = ctor.GetParameters();
            var convertedArgs = ConvertArguments(parameters, ctorArgs);
            return ctor.Invoke(convertedArgs);
        }

        // Try to resolve using DI for interface parameters
        foreach (var constructor in constructors.OrderByDescending(c => c.GetParameters().Length))
        {
            try
            {
                var parameters = constructor.GetParameters();
                var args = new object?[parameters.Length];

                for (int i = 0; i < parameters.Length; i++)
                {
                    var param = parameters[i];

                    // Try ctorArgs first
                    if (ctorArgs != null && i < ctorArgs.Length)
                    {
                        args[i] = ConvertValue(ctorArgs[i], param.ParameterType);
                    }
                    // Try DI resolution
                    else if (param.ParameterType.IsInterface || param.ParameterType.IsAbstract)
                    {
                        var service = _serviceProvider.GetService(param.ParameterType);
                        if (service != null)
                        {
                            args[i] = service;
                        }
                        else if (param.HasDefaultValue)
                        {
                            args[i] = param.DefaultValue;
                        }
                        else
                        {
                            throw new InvalidOperationException(
                                $"Cannot resolve parameter '{param.Name}' of type '{GetFriendlyTypeName(param.ParameterType)}'");
                        }
                    }
                    else if (param.HasDefaultValue)
                    {
                        args[i] = param.DefaultValue;
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            $"Missing value for parameter '{param.Name}' of type '{GetFriendlyTypeName(param.ParameterType)}'");
                    }
                }

                return constructor.Invoke(args);
            }
            catch
            {
                continue;
            }
        }

        var ctorInfo = constructors.Select(c => new CtorSignature
        {
            Params = c.GetParameters().Select(p => $"{GetFriendlyTypeName(p.ParameterType)} {p.Name}").ToList()
        }).ToList();

        throw new InvalidOperationException($"Cannot construct type '{type.FullName}'")
        {
            Data = { ["constructors"] = ctorInfo }
        };
    }

    private object?[]? ConvertArguments(ParameterInfo[] parameters, object?[]? args)
    {
        if (args == null || args.Length == 0)
            return null;

        var converted = new object?[parameters.Length];

        for (int i = 0; i < parameters.Length; i++)
        {
            if (i < args.Length)
            {
                converted[i] = ConvertValue(args[i], parameters[i].ParameterType);
            }
            else if (parameters[i].HasDefaultValue)
            {
                converted[i] = parameters[i].DefaultValue;
            }
            else
            {
                throw new ArgumentException($"Missing argument for parameter '{parameters[i].Name}'");
            }
        }

        return converted;
    }

    private object? ConvertValue(object? value, Type targetType)
    {
        if (value == null)
            return null;

        if (targetType.IsAssignableFrom(value.GetType()))
            return value;

        // Handle JsonElement from deserialization
        if (value is JsonElement element)
        {
            return ConvertJsonElement(element, targetType);
        }

        // Try direct conversion
        try
        {
            return Convert.ChangeType(value, targetType);
        }
        catch
        {
            // Try JSON round-trip for complex types
            var json = JsonSerializer.Serialize(value);
            return JsonSerializer.Deserialize(json, targetType);
        }
    }

    private object? ConvertJsonElement(JsonElement element, Type targetType)
    {
        return element.ValueKind switch
        {
            JsonValueKind.Null => null,
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.String when targetType == typeof(string) => element.GetString(),
            JsonValueKind.String when targetType == typeof(DateTime) => element.GetDateTime(),
            JsonValueKind.String when targetType == typeof(Guid) => element.GetGuid(),
            JsonValueKind.String => element.GetString(),
            JsonValueKind.Number when targetType == typeof(int) => element.GetInt32(),
            JsonValueKind.Number when targetType == typeof(long) => element.GetInt64(),
            JsonValueKind.Number when targetType == typeof(double) => element.GetDouble(),
            JsonValueKind.Number when targetType == typeof(float) => element.GetSingle(),
            JsonValueKind.Number when targetType == typeof(decimal) => element.GetDecimal(),
            JsonValueKind.Number => element.GetDouble(),
            _ => JsonSerializer.Deserialize(element.GetRawText(), targetType)
        };
    }

    private object? SerializeValue(object? value)
    {
        if (value == null)
            return null;

        var type = value.GetType();

        // Primitives serialize directly
        if (type.IsPrimitive || value is string || value is decimal)
            return value;

        // Try to serialize as JSON and return the document
        try
        {
            var json = JsonSerializer.Serialize(value, new JsonSerializerOptions
            {
                WriteIndented = false,
                MaxDepth = 10
            });
            return JsonSerializer.Deserialize<JsonElement>(json);
        }
        catch
        {
            return value.ToString();
        }
    }

    private static string GetFriendlyTypeName(Type type)
    {
        if (type == typeof(void)) return "void";
        if (type == typeof(int)) return "int";
        if (type == typeof(long)) return "long";
        if (type == typeof(short)) return "short";
        if (type == typeof(byte)) return "byte";
        if (type == typeof(bool)) return "bool";
        if (type == typeof(string)) return "string";
        if (type == typeof(double)) return "double";
        if (type == typeof(float)) return "float";
        if (type == typeof(decimal)) return "decimal";
        if (type == typeof(object)) return "object";

        if (type.IsGenericType)
        {
            var genericDef = type.GetGenericTypeDefinition();
            var genericArgs = string.Join(", ", type.GetGenericArguments().Select(GetFriendlyTypeName));

            if (genericDef == typeof(Nullable<>))
                return $"{genericArgs}?";

            if (genericDef == typeof(Task<>))
                return $"Task<{genericArgs}>";

            if (genericDef == typeof(List<>))
                return $"List<{genericArgs}>";

            if (genericDef == typeof(Dictionary<,>))
                return $"Dictionary<{genericArgs}>";

            var name = type.Name;
            var backtickIndex = name.IndexOf('`');
            if (backtickIndex > 0)
                name = name.Substring(0, backtickIndex);

            return $"{name}<{genericArgs}>";
        }

        if (type.IsArray)
            return $"{GetFriendlyTypeName(type.GetElementType()!)}[]";

        return type.Name;
    }

    private static InvokeResult Fail(InvokeResult result, string error, ErrorDetails? details = null)
    {
        result.Success = false;
        result.Error = error;
        result.ErrorDetails = details;
        return result;
    }
}
