using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using McpNetcoreDbg.Harness.Models;

namespace McpNetcoreDbg.Harness;

public class MethodInvoker
{
    private readonly CapturingLoggerProvider _loggerProvider;
    private IServiceProvider? _serviceProvider;
    private readonly Dictionary<Type, Type> _interfaceToConcreteMap = new();

    public MethodInvoker(CapturingLoggerProvider loggerProvider)
    {
        _loggerProvider = loggerProvider;
    }

    private IServiceProvider BuildServiceProvider(Assembly targetAssembly)
    {
        var services = new ServiceCollection();

        // Register logging
        services.AddSingleton<ILoggerFactory>(new CapturingLoggerFactory(_loggerProvider));
        services.AddSingleton(typeof(ILogger<>), typeof(Logger<>));

        // Register HttpClient for external API calls
        services.AddSingleton<HttpClient>();

        // Register IOptions<T> support - creates empty options by default
        services.AddSingleton(typeof(IOptions<>), typeof(EmptyOptionsWrapper<>));

        // Scan target assembly and all referenced assemblies for interface implementations
        var assemblies = GetAssembliesWithReferences(targetAssembly);
        ScanAndRegisterServices(services, assemblies);

        return services.BuildServiceProvider();
    }

    private List<Assembly> GetAssembliesWithReferences(Assembly rootAssembly)
    {
        var assemblies = new List<Assembly> { rootAssembly };
        var assemblyDir = Path.GetDirectoryName(rootAssembly.Location) ?? "";

        foreach (var refName in rootAssembly.GetReferencedAssemblies())
        {
            try
            {
                // Try to load from the same directory as the root assembly
                var refPath = Path.Combine(assemblyDir, refName.Name + ".dll");
                if (File.Exists(refPath))
                {
                    var refAssembly = Assembly.LoadFrom(refPath);
                    assemblies.Add(refAssembly);
                }
            }
            catch
            {
                // Skip assemblies that can't be loaded
            }
        }

        return assemblies;
    }

    private void ScanAndRegisterServices(IServiceCollection services, List<Assembly> assemblies)
    {
        // Find all interfaces and their concrete implementations
        var interfaces = new Dictionary<Type, List<Type>>();

        foreach (var assembly in assemblies)
        {
            Type[] types;
            try
            {
                types = assembly.GetTypes();
            }
            catch (ReflectionTypeLoadException ex)
            {
                // GetTypes() fails if some types can't be loaded, but we can still get the ones that did load
                types = ex.Types.Where(t => t != null).ToArray()!;
            }
            catch
            {
                // Skip assemblies that completely fail
                continue;
            }

            foreach (var type in types)
            {
                try
                {
                    if (type.IsClass && !type.IsAbstract && type.IsPublic)
                    {
                        foreach (var iface in type.GetInterfaces())
                        {
                            // Skip generic interfaces and system/microsoft interfaces
                            if (iface.IsGenericType)
                                continue;

                            if (iface.Namespace?.StartsWith("System") == true ||
                                iface.Namespace?.StartsWith("Microsoft") == true)
                                continue;

                            if (!interfaces.ContainsKey(iface))
                                interfaces[iface] = new List<Type>();

                            interfaces[iface].Add(type);
                        }
                    }
                }
                catch
                {
                    // Skip types that fail to inspect
                }
            }
        }

        // Register implementations - prefer naming convention (IFoo -> Foo)
        foreach (var kvp in interfaces)
        {
            var iface = kvp.Key;
            var implementations = kvp.Value;

            if (implementations.Count == 0)
                continue;

            Type? bestMatch = null;

            // Look for naming convention match: IFoo -> Foo or IFooBar -> FooBar
            var expectedName = iface.Name.StartsWith("I") ? iface.Name.Substring(1) : iface.Name;
            bestMatch = implementations.FirstOrDefault(t => t.Name == expectedName);

            // Fallback: use the first implementation
            bestMatch ??= implementations.First();

            // Register the mapping
            _interfaceToConcreteMap[iface] = bestMatch;
            services.AddTransient(iface, sp => ResolveWithDI(sp, bestMatch));
        }
    }

    private object ResolveWithDI(IServiceProvider sp, Type concreteType)
    {
        var constructors = concreteType.GetConstructors()
            .OrderByDescending(c => c.GetParameters().Length)
            .ToList();

        foreach (var ctor in constructors)
        {
            try
            {
                var parameters = ctor.GetParameters();
                var args = new object?[parameters.Length];

                for (int i = 0; i < parameters.Length; i++)
                {
                    var param = parameters[i];

                    // Try to resolve from service provider
                    var service = sp.GetService(param.ParameterType);
                    if (service != null)
                    {
                        args[i] = service;
                    }
                    else if (param.HasDefaultValue)
                    {
                        args[i] = param.DefaultValue;
                    }
                    else if (!param.ParameterType.IsInterface && !param.ParameterType.IsAbstract)
                    {
                        // Try to create concrete type with parameterless constructor
                        if (param.ParameterType.GetConstructor(Type.EmptyTypes) != null)
                        {
                            args[i] = Activator.CreateInstance(param.ParameterType);
                        }
                        else
                        {
                            throw new InvalidOperationException(
                                $"Cannot resolve parameter '{param.Name}' of type '{param.ParameterType.Name}'");
                        }
                    }
                    else
                    {
                        throw new InvalidOperationException(
                            $"Cannot resolve parameter '{param.Name}' of type '{param.ParameterType.Name}'");
                    }
                }

                return ctor.Invoke(args);
            }
            catch
            {
                continue;
            }
        }

        throw new InvalidOperationException($"Cannot construct type '{concreteType.FullName}'");
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

            // Build service provider with auto-discovered services from the target assembly
            _serviceProvider = BuildServiceProvider(assembly);

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

        // Try to find matching constructor with provided args
        var argCount = ctorArgs?.Length ?? 0;
        var ctor = constructors.FirstOrDefault(c => c.GetParameters().Length == argCount);

        if (ctor != null && ctorArgs != null && ctorArgs.Length > 0)
        {
            var parameters = ctor.GetParameters();
            var convertedArgs = ConvertArguments(parameters, ctorArgs);
            return ctor.Invoke(convertedArgs);
        }

        // Try to resolve using DI for interface/abstract parameters
        foreach (var constructor in constructors.OrderByDescending(c => c.GetParameters().Length))
        {
            try
            {
                var parameters = constructor.GetParameters();
                var args = new object?[parameters.Length];
                var allResolved = true;

                for (int i = 0; i < parameters.Length; i++)
                {
                    var param = parameters[i];

                    // Try ctorArgs first
                    if (ctorArgs != null && i < ctorArgs.Length)
                    {
                        args[i] = ConvertValue(ctorArgs[i], param.ParameterType);
                    }
                    // Try DI resolution for interfaces/abstract types
                    else if (param.ParameterType.IsInterface || param.ParameterType.IsAbstract)
                    {
                        var service = _serviceProvider?.GetService(param.ParameterType);
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
                            allResolved = false;
                            break;
                        }
                    }
                    // Try creating concrete types directly
                    else if (!param.ParameterType.IsInterface && !param.ParameterType.IsAbstract)
                    {
                        var service = _serviceProvider?.GetService(param.ParameterType);
                        if (service != null)
                        {
                            args[i] = service;
                        }
                        else if (param.ParameterType.GetConstructor(Type.EmptyTypes) != null)
                        {
                            args[i] = Activator.CreateInstance(param.ParameterType);
                        }
                        else if (param.HasDefaultValue)
                        {
                            args[i] = param.DefaultValue;
                        }
                        else
                        {
                            allResolved = false;
                            break;
                        }
                    }
                    else if (param.HasDefaultValue)
                    {
                        args[i] = param.DefaultValue;
                    }
                    else
                    {
                        allResolved = false;
                        break;
                    }
                }

                if (allResolved)
                {
                    return constructor.Invoke(args);
                }
            }
            catch
            {
                continue;
            }
        }

        // Build helpful error message with constructor info
        var ctorInfo = constructors.Select(c => new CtorSignature
        {
            Params = c.GetParameters().Select(p => $"{GetFriendlyTypeName(p.ParameterType)} {p.Name}").ToList()
        }).ToList();

        // List what services we discovered
        var discoveredServices = _interfaceToConcreteMap
            .Select(kvp => $"{kvp.Key.Name} -> {kvp.Value.Name}")
            .Take(30)
            .ToList();

        // List what the constructors need
        var neededInterfaces = constructors
            .SelectMany(c => c.GetParameters())
            .Where(p => p.ParameterType.IsInterface)
            .Select(p => p.ParameterType.FullName)
            .Distinct()
            .ToList();

        throw new InvalidOperationException(
            $"Cannot construct type '{type.FullName}'.\n" +
            $"Needed interfaces: [{string.Join(", ", neededInterfaces)}]\n" +
            $"Discovered services ({_interfaceToConcreteMap.Count}): [{string.Join(", ", discoveredServices)}]")
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

/// <summary>
/// IOptions wrapper that returns an empty/default instance of T.
/// Used for auto-wiring when no explicit configuration is provided.
/// </summary>
internal class EmptyOptionsWrapper<T> : IOptions<T> where T : class, new()
{
    public T Value { get; } = new T();
}
