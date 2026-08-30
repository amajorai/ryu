import XCTest
@testable import RyuSdk

final class RyuSdkTests: XCTestCase {
    func testValidationAndEgressUseTheRustKernel() throws {
        XCTAssertNoThrow(try validatePluginId(id: "io.ryu.swift"))
        XCTAssertThrowsError(try validatePluginId(id: "../evil"))
        XCTAssertNoThrow(try assertAllowedEgress(url: "http://127.0.0.1:7981"))
        XCTAssertThrowsError(try assertAllowedEgress(url: "https://api.openai.com"))
    }

    func testManifestAndClientSurface() throws {
        let manifest = """
        {"id":"com.example.swift","name":"Swift","version":"1.0.0","runnables":[]}
        """
        let normalized = try parseAndValidateManifest(json: manifest)
        XCTAssertTrue(normalized.contains("com.example.swift"))
        XCTAssertTrue(pluginManifestJsonSchema().contains("properties"))

        let client = try ModelClient(model: "gemma4", baseUrl: "http://127.0.0.1:7981", token: nil)
        XCTAssertNotNil(client)
        XCTAssertThrowsError(try ModelClient(model: "gpt-4o", baseUrl: "https://api.openai.com", token: nil))
    }
}
