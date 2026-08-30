// End-to-end pipeline proof for the Ryu C# binding.
//
// This does NOT hit the network. It exercises the SHARED Rust rules through the
// uniffi-bindgen-cs-generated `uniffi.ryu_sdk` surface, proving the pipeline works:
//
//     crates/sdk/uniffi (cdylib)
//         -> uniffi-bindgen-cs --library ryu_sdk_uniffi.dll
//         -> using uniffi.ryu_sdk;
//         -> the same egress / plugin-id rules every binding enforces.
//
// The generated `ryu_sdk.cs` marks its types `internal`, so this smoke compiles in
// the SAME assembly (both .cs files are globbed into one project). Exits non-zero
// on any failure so a runner goes red if the generated surface drifts.

using System;
using uniffi.ryu_sdk;

// 1. Plugin id validation: the path-traversal-safe rule.
RyuSdkMethods.ValidatePluginId("io.ryu.ok");
try
{
    RyuSdkMethods.ValidatePluginId("../evil");
    Console.Error.WriteLine("FAIL: '../evil' should have been rejected");
    return 1;
}
catch (RyuException)
{
    // expected
}

// 2. Manifest and schema validation: the same Rust contract as every binding.
var normalized = RyuSdkMethods.ParseAndValidateManifest(
    "{\"id\":\"com.example.csharp\",\"name\":\"C#\",\"version\":\"1.0.0\",\"runnables\":[]}"
);
if (!normalized.Contains("com.example.csharp", StringComparison.Ordinal))
{
    Console.Error.WriteLine("FAIL: normalized manifest lost its id");
    return 1;
}
if (!RyuSdkMethods.PluginManifestJsonSchema().Contains("properties", StringComparison.Ordinal))
{
    Console.Error.WriteLine("FAIL: manifest schema has no properties");
    return 1;
}
try
{
    RyuSdkMethods.ParseAndValidateManifest(
        "{\"id\":\"com.example.csharp\",\"name\":\"C#\",\"version\":\"nope\",\"runnables\":[]}"
    );
    Console.Error.WriteLine("FAIL: invalid semver was accepted");
    return 1;
}
catch (RyuException)
{
    // expected
}

// 3. Gateway egress blocklist: the governance invariant — direct providers blocked.
RyuSdkMethods.AssertAllowedEgress("http://127.0.0.1:7981");
try
{
    RyuSdkMethods.AssertAllowedEgress("https://api.openai.com");
    Console.Error.WriteLine("FAIL: api.openai.com egress should be blocked");
    return 1;
}
catch (RyuException)
{
    // expected
}

// 4. Both object clients construct only with a Gateway URL. No request is sent.
if (!RyuSdkMethods.ResolveGatewayUrl().StartsWith("http", StringComparison.Ordinal))
{
    Console.Error.WriteLine("FAIL: Gateway URL did not resolve");
    return 1;
}
_ = RyuSdkMethods.ResolveGatewayToken();
var model = new ModelClient("gemma4", "http://127.0.0.1:7981", null);
var embedder = new EmbeddingClient("nomic-embed-text-v1.5", "http://127.0.0.1:7981", null);
model.Dispose();
embedder.Dispose();

Console.WriteLine("ryu_sdk C# binding smoke test: OK");
return 0;
