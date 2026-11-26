// swift-tools-version: 6.0
import PackageDescription

// Live call transcription sidecar: Nemotron Speech Streaming 0.6B (560 ms) on the Neural Engine via
// FluidAudio. The call worker (src-tauri/src/calls/worker.py) starts it and talks to it over pipes.
let package = Package(
    name: "handy-stream-asr",
    platforms: [.macOS(.v14)],
    dependencies: [.package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.0")],
    targets: [
        .target(name: "StreamCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "handy-stream-asr", dependencies: ["StreamCore", "FluidAudio"],
                          swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "StreamCoreTests", dependencies: ["StreamCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)
