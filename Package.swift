// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "HeedShell",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(
      name: "HeedShell",
      path: "Sources/HeedShell",
      linkerSettings: [
        .linkedFramework("AppKit"),
        .linkedFramework("WebKit"),
        .linkedFramework("Carbon")
      ]
    )
  ]
)

