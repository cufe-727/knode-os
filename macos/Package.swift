// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "KnodeOS",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "KnodeOS", targets: ["KnodeOSApp"]),
    ],
    targets: [
        .executableTarget(
            name: "KnodeOSApp",
            path: "Sources/KnodeOSApp",
            resources: [.copy("Resources")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
