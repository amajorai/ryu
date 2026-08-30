// swift-tools-version: 5.9

import PackageDescription
import Foundation

let packageRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .path

let package = Package(
    name: "RyuSdkExample",
    products: [
        .executable(name: "ryu-sdk-example", targets: ["RyuSdkExample"]),
        .library(name: "RyuSdk", targets: ["RyuSdk"]),
    ],
    targets: [
        .systemLibrary(name: "RyuSdkFFI", path: "Sources/RyuSdkFFI"),
        .target(
            name: "RyuSdk",
            dependencies: ["RyuSdkFFI"],
            path: "Sources/RyuSdk",
            linkerSettings: [
                .unsafeFlags(["-L\(packageRoot)/../../target/release"]),
                .linkedLibrary("ryu_sdk_uniffi"),
            ]
        ),
        .executableTarget(name: "RyuSdkExample", dependencies: ["RyuSdk"]),
        .testTarget(name: "RyuSdkTests", dependencies: ["RyuSdk"]),
    ]
)
