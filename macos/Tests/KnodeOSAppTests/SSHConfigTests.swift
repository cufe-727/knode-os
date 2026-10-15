import Foundation
import XCTest
@testable import KnodeOSApp

final class SSHConfigTests: XCTestCase {
    private var home: URL!

    override func setUpWithError() throws {
        home = FileManager.default.temporaryDirectory.appendingPathComponent("knode ssh tests \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: home.appendingPathComponent(".ssh"), withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: home)
    }

    private func write(_ path: String, _ content: String) throws {
        let file = home.appendingPathComponent(".ssh").appendingPathComponent(path)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try content.write(to: file, atomically: true, encoding: .utf8)
    }

    func testDiscoversLiteralAliasesWithSSHWhitespaceQuotesAndEquals() throws {
        try write("config", """
        # Host ignored
        Host alpha beta *.corp !excluded ?wild
          HostName not-an-alias.example
          User someone
        hOsT="quoted" alpha # duplicate
        Host =other
        Host = spaced-equals
        Host -invalid "invalid alias"
        Match host not-a-host exec "do-not-run"
        """)
        XCTAssertEqual(SSHConfig.hosts(home: home).names, ["alpha", "beta", "other", "quoted", "spaced-equals"])
    }

    func testIncludesGlobsSpacesHomePathsAndCycles() throws {
        try write("config", """
        Include config.d/*.conf "with spaces.conf" ~/.ssh/home.conf
        Host root
        """)
        try write("config.d/first.conf", "Host first\nInclude nested.conf")
        // Relative includes are resolved under ~/.ssh, not the including file.
        try write("nested.conf", "Host nested\nInclude config")
        try write("config.d/second.conf", "Host second root")
        try write("with spaces.conf", "Host spaced")
        try write("home.conf", "Host tilde\nInclude missing-*.conf")
        let result = SSHConfig.hosts(home: home)
        XCTAssertEqual(result.names, ["first", "nested", "root", "second", "spaced", "tilde"])
        XCTAssertTrue(result.unreadableFiles.isEmpty)
    }

    func testNoConfigAndUnreadableIncludeAreHandled() throws {
        XCTAssertTrue(SSHConfig.hosts(home: home).names.isEmpty)
        try write("config", "Host usable\nInclude invalid.conf")
        try Data([0xff, 0xfe, 0xff]).write(to: home.appendingPathComponent(".ssh/invalid.conf"))
        let result = SSHConfig.hosts(home: home)
        XCTAssertEqual(result.names, ["usable"])
        XCTAssertEqual(result.unreadableFiles.count, 1)
    }

    func testDiscoveryDoesNotExecuteMatchCommands() throws {
        let marker = home.appendingPathComponent("executed")
        try write("config", "Match exec \"touch '\(marker.path)'\"\nHost selectable")
        XCTAssertEqual(SSHConfig.hosts(home: home).names, ["selectable"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }

    func testTunnelInheritsConfigIncludingJumpHostAndIdentity() throws {
        try write("config", """
        Host example
          HostName 192.0.2.10
          User alice
          Port 2222
          IdentityFile ~/.ssh/test_identity
          ProxyJump bastion
        """)
        var settings = ConnectionSettings()
        settings.mode = .ssh
        settings.sshDestination = "example"
        let args = try SSHTunnel.arguments(for: settings, localPort: 12345)
        XCTAssertFalse(args.contains("-p"))
        XCTAssertFalse(args.contains("-i"))
        XCTAssertTrue(args.contains("127.0.0.1:12345:127.0.0.1:9100"))
        let effective = try effectiveConfig(settings)
        XCTAssertTrue(effective.contains("hostname 192.0.2.10\n"))
        XCTAssertTrue(effective.contains("user alice\n"))
        XCTAssertTrue(effective.contains("port 2222\n"))
        XCTAssertTrue(effective.contains("identityfile ~/.ssh/test_identity\n"))
        XCTAssertTrue(effective.contains("proxyjump bastion\n"))
    }

    func testExplicitPort22OverridesConfiguredPort() throws {
        try write("config", "Host example\n  Port 2222")
        var settings = ConnectionSettings()
        settings.sshDestination = "example"
        settings.sshPort = 22
        settings.sshIdentityFile = "  ~/a key  "
        let args = try SSHTunnel.arguments(for: settings, localPort: 12345)
        XCTAssertEqual(args[try XCTUnwrap(args.firstIndex(of: "-p")) + 1], "22")
        XCTAssertEqual(args[try XCTUnwrap(args.firstIndex(of: "-i")) + 1], NSHomeDirectory() + "/a key")
        XCTAssertTrue(try effectiveConfig(settings).contains("port 22\n"))
    }

    func testTunnelOwnsForegroundConnectionDespiteMultiplexingConfig() throws {
        try write("config", """
        Host example
          ControlMaster auto
          ControlPath ~/.ssh/shared-%h
          ControlPersist 600
          ForkAfterAuthentication yes
          ProxyJump bastion
          User alice
          Port 2222
        """)
        var settings = ConnectionSettings()
        settings.sshDestination = "example"
        let effective = try effectiveConfig(settings)
        XCTAssertTrue(effective.contains("controlmaster false\n"))
        XCTAssertFalse(effective.contains("controlpath "))
        XCTAssertTrue(effective.contains("controlpersist no\n"))
        XCTAssertTrue(effective.contains("forkafterauthentication no\n"))
        XCTAssertTrue(effective.contains("proxyjump bastion\n"))
        XCTAssertTrue(effective.contains("user alice\n"))
        XCTAssertTrue(effective.contains("port 2222\n"))
    }

    func testRejectsInvalidDestinationsAndPorts() throws {
        var settings = ConnectionSettings()
        for destination in ["", "-option", "host name", "host\tname", "host\nname"] {
            settings.sshDestination = destination
            XCTAssertThrowsError(try SSHTunnel.arguments(for: settings, localPort: 12345))
        }
        settings.sshDestination = "valid"
        for port in [0, -1, 65536] {
            settings.sshPort = port
            XCTAssertThrowsError(try SSHTunnel.arguments(for: settings, localPort: 12345))
        }
        settings.sshPort = nil
        settings.sshRemotePort = 65536
        XCTAssertThrowsError(try SSHTunnel.arguments(for: settings, localPort: 12345))
    }

    func testInheritedPortAndExplicitPortDoNotShareLoginSessions() {
        var inherited = ConnectionSettings()
        inherited.mode = .ssh
        inherited.sshDestination = "example"
        var overridden = inherited
        overridden.sshPort = 22
        XCTAssertNotEqual(inherited.identity, overridden.identity)
        XCTAssertNotEqual(inherited.identity, "ssh|example:22|9100")
        XCTAssertNotEqual(overridden.identity, "ssh|example:22|9100")
    }

    /// -G evaluates only this synthetic config; it does not connect to a host.
    private func effectiveConfig(_ settings: ConnectionSettings) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        process.arguments = ["-G", "-F", home.appendingPathComponent(".ssh/config").path]
            + (try SSHTunnel.arguments(for: settings, localPort: 12345))
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0)
        return String(decoding: data, as: UTF8.self)
    }
}
