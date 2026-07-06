// End-to-end pipeline proof for the Ryu C# binding.
//
// This does NOT hit the network. It exercises the SHARED Rust rules through the
// uniffi-bindgen-cs-generated `uniffi.ryu_sdk` surface, proving the pipeline works:
//
//     crates/ryu-sdk-uniffi (cdylib)
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

// 2. Gateway egress blocklist: the moat invariant — direct providers blocked.
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

Console.WriteLine("ryu_sdk C# binding smoke test: OK");
return 0;
