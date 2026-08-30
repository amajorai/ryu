import RyuSdk

do {
    try validatePluginId(id: "com.example.swift")
    try assertAllowedEgress(url: "http://127.0.0.1:7981")
    _ = try ModelClient(model: "gemma4", baseUrl: "http://127.0.0.1:7981", token: nil)
    print("Ryu Swift SDK example ready: \(resolveGatewayUrl())")
} catch {
    fatalError("Ryu Swift SDK example failed: \(error)")
}
