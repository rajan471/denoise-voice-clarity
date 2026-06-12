// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DenoiseVoiceClarity",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "VoiceClarity", targets: ["VoiceClarity"])],
    dependencies: [
        .package(url: "https://github.com/livekit/client-sdk-swift.git", from: "2.15.0"),
    ],
    targets: [
        // Built by scripts/build-ios.sh (Rust static libs + the headers in
        // Sources/DenoiseVoiceCoreFFI/include, modulemap included). Not
        // committed; CI / Xcode machines must run the script first.
        .binaryTarget(
            name: "DenoiseVoiceCoreFFI",
            path: "Frameworks/DenoiseVoiceCoreFFI.xcframework"
        ),
        .target(
            name: "VoiceClarity",
            dependencies: [
                "DenoiseVoiceCoreFFI",
                .product(name: "LiveKit", package: "client-sdk-swift"),
            ]
        ),
        .testTarget(name: "VoiceClarityTests", dependencies: ["VoiceClarity"]),
    ]
)
