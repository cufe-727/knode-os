import CryptoKit
import Darwin
import Foundation
import Security

/// How the app reaches a knode-os service.
///
///   local   a service on this Mac — the LaunchAgent, or the one bundled in the
///           app, which starts itself when nothing answers
///   remote  a service elsewhere over HTTPS: a domain behind Cloudflare Tunnel,
///           or an address with its own certificate (`server.tls`)
///   ssh     a service on a machine you can SSH into, through a tunnel the app
///           keeps open: `ssh -L` to that machine's loopback port, so nothing
///           but SSH has to be reachable from here
///
/// Whatever the way in, the service asks you to sign in.
enum ConnectionMode: String, Codable, CaseIterable, Identifiable {
    case local
    case remote
    case ssh

    var id: String { rawValue }
}

struct ConnectionSettings: Codable, Equatable {
    var mode: ConnectionMode = .local
    /// `serve`'s own default port; an existing install keeps the URL it had (AppModel migrates it).
    var localURL = "http://127.0.0.1:9100"
    var remoteURL = ""
    /// `user@host`, or a Host alias from ~/.ssh/config.
    var sshDestination = ""
    /// Explicit SSH port override; nil lets OpenSSH read ~/.ssh/config.
    var sshPort: Int?
    /// The address at which the app runs the service bundled inside it when
    /// nothing answers. Any other local URL is a service managed elsewhere (the
    /// LaunchAgent): the app never starts a second one there, which would open
    /// the same data directory while that one restarts.
    static let bundledServiceURL = "http://127.0.0.1:9100"

    var usesBundledService: Bool {
        mode == .local && Self.trimmed(localURL) == Self.bundledServiceURL
    }

    /// Port of knode-os on the far machine, on its loopback (`server.port` there).
    var sshRemotePort = 9100
    /// Private key to use instead of ssh-agent / ~/.ssh/config.
    var sshIdentityFile = ""
    /// SHA-256 fingerprints of self-signed certificates you chose to trust, by "host:port".
    var pinnedCertificates: [String: String] = [:]

    /// One name per service, so a session made for one is never sent to another.
    var identity: String {
        switch mode {
        case .local: "local|\(Self.trimmed(localURL))"
        case .remote: "remote|\(Self.trimmed(remoteURL))"
        // An inherited port can be different from an explicit 22. Version the
        // key so legacy sessions, which conflated them, require a fresh sign-in.
        case .ssh: "ssh-v2|\(sshDestination.trimmingCharacters(in: .whitespacesAndNewlines)):\(sshPort.map(String.init) ?? "config")|\(sshRemotePort)"
        }
    }

    /// What to show for where the app is connected.
    var summary: String {
        switch mode {
        case .local: Self.trimmed(localURL)
        case .remote: Self.trimmed(remoteURL)
        case .ssh: "ssh \(sshDestination) → :\(sshRemotePort)"
        }
    }

    static func trimmed(_ value: String) -> String {
        let t = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.hasSuffix("/") ? String(t.dropLast()) : t
    }
}

/// An SSH local forward the app owns: `ssh -N -L 127.0.0.1:<free>:127.0.0.1:<remotePort> <destination>`.
///
/// It runs with `BatchMode=yes`, so it never asks for a password — the key must
/// be in ssh-agent or the Keychain, as for any unattended SSH — and it honours
/// ~/.ssh/config (aliases, ProxyJump, known hosts). A host key that is not
/// known yet is refused: connect once in Terminal to trust it.
final class SSHTunnel {
    private var process: Process?
    private var errorPipe: Pipe?
    private var stderrText = ""
    private let lock = NSLock()
    private(set) var localPort: Int?
    private var configuration: ConnectionSettings?

    var isRunning: Bool { process?.isRunning == true }

    var exitStatus: Int32? {
        guard let process, !process.isRunning else { return nil }
        return process.terminationStatus
    }

    /// What ssh said on stderr, last line first matters most.
    var lastError: String {
        lock.lock()
        defer { lock.unlock() }
        let lines = stderrText.split(separator: "\n").map(String.init).filter { !$0.hasPrefix("Warning: Permanently added") }
        return lines.suffix(3).joined(separator: " ")
    }

    /// Start (or keep) the tunnel for these settings; returns the local port.
    @discardableResult
    func start(_ settings: ConnectionSettings) throws -> Int {
        // Validate before stopping an existing tunnel.
        _ = try Self.arguments(for: settings, localPort: 1)
        if isRunning, configuration == settings, let localPort { return localPort }
        stop()

        let port = try Self.freeLocalPort()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        task.arguments = try Self.arguments(for: settings, localPort: port)
        let pipe = Pipe()
        task.standardError = pipe
        task.standardOutput = FileHandle.nullDevice
        task.standardInput = FileHandle.nullDevice
        lock.lock()
        stderrText = ""
        lock.unlock()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let self else { return }
            self.lock.lock()
            self.stderrText += String(decoding: data, as: UTF8.self)
            if self.stderrText.count > 8_000 { self.stderrText = String(self.stderrText.suffix(4_000)) }
            self.lock.unlock()
        }
        do {
            try task.run()
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            throw APIError(message: "Could not start ssh: \(error.localizedDescription)")
        }
        process = task
        errorPipe = pipe
        localPort = port
        configuration = settings
        return port
    }

    static func arguments(for settings: ConnectionSettings, localPort: Int) throws -> [String] {
        let destination = settings.sshDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !destination.isEmpty else { throw APIError(message: "Enter the SSH destination, e.g. you@mac-mini.local") }
        guard !destination.hasPrefix("-"), !destination.contains(where: { $0.isWhitespace || $0.isNewline }) else { throw APIError(message: "That is not an SSH destination") }
        guard (1...65_535).contains(settings.sshRemotePort) else { throw APIError(message: "The service port must be 1–65535") }
        if let port = settings.sshPort, !(1...65_535).contains(port) { throw APIError(message: "The SSH port must be 1–65535") }
        var args = [
            "-N", "-T",
            // Own the foreground process and its forward. A multiplexed client
            // can exit 0 immediately after handing the forward to a shared
            // master; ControlPersist / -f can also leave an unowned background
            // process. Keep all host, authentication and ProxyJump settings.
            "-o", "ControlMaster=no",
            "-o", "ControlPath=none",
            "-o", "ControlPersist=no",
            "-o", "ForkAfterAuthentication=no",
            "-o", "BatchMode=yes",
            "-o", "ExitOnForwardFailure=yes",
            "-o", "ConnectTimeout=10",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-L", "127.0.0.1:\(localPort):127.0.0.1:\(settings.sshRemotePort)",
        ]
        if let sshPort = settings.sshPort { args += ["-p", String(sshPort)] }
        let identity = (settings.sshIdentityFile.trimmingCharacters(in: .whitespacesAndNewlines) as NSString).expandingTildeInPath
        if !identity.isEmpty { args += ["-i", identity, "-o", "IdentitiesOnly=yes"] }
        args += ["--", destination]
        return args
    }

    func stop() {
        errorPipe?.fileHandleForReading.readabilityHandler = nil
        errorPipe = nil
        if let process, process.isRunning { process.terminate() }
        process = nil
        localPort = nil
        configuration = nil
    }

    /// A port nothing listens on, from the system: the forward binds it on loopback only.
    static func freeLocalPort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw APIError(message: "No free local port for the SSH tunnel") }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw APIError(message: "No free local port for the SSH tunnel") }
        var out = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &out) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard named == 0 else { throw APIError(message: "No free local port for the SSH tunnel") }
        return Int(UInt16(bigEndian: out.sin_port))
    }
}

/// Session tokens, one per service, in `~/Library/Application Support/KnodeOS/sessions.json`
/// (0600, under the private ~/Library) — never in UserDefaults.
///
/// Not the Keychain: this app is ad-hoc signed, so every rebuild is a new
/// code identity, and the Keychain would ask for the login password after
/// each install before handing the token back (verified 2026-10-15). A token
/// here is as safe as the user's other files; the service ends it on
/// sign-out, password change, or after `server.auth.sessionDays` unused.
enum SessionTokens {
    private static var file: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support", isDirectory: true)
        return base.appendingPathComponent("KnodeOS", isDirectory: true).appendingPathComponent("sessions.json")
    }

    static func read(_ service: String) -> String? {
        load()[service]
    }

    static func save(_ token: String, for service: String) {
        var all = load()
        all[service] = token
        store(all)
    }

    static func delete(_ service: String) {
        var all = load()
        guard all.removeValue(forKey: service) != nil else { return }
        store(all)
    }

    private static func load() -> [String: String] {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: String].self, from: data)) ?? [:]
    }

    private static func store(_ all: [String: String]) {
        let fm = FileManager.default
        let dir = file.deletingLastPathComponent()
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard let data = try? JSONEncoder().encode(all) else { return }
        // written private from the first byte, then moved into place whole
        let temp = dir.appendingPathComponent(".sessions.\(UUID().uuidString).tmp")
        guard fm.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else { return }
        if rename(temp.path, file.path) != 0 { try? fm.removeItem(at: temp) }
    }
}

/// Trust for a server whose certificate the system does not: a self-signed
/// `server.tls` reached by IP. A certificate the system trusts passes as usual;
/// any other passes only if its SHA-256 fingerprint is one you pinned for that
/// host and port, and the one it showed is kept so the app can offer to pin it.
final class PinningDelegate: NSObject, URLSessionDelegate {
    private let pins: [String: String]

    init(pins: [String: String]) {
        self.pins = pins
    }

    nonisolated(unsafe) static var lastSeen: [String: String] = [:]
    private static let seenLock = NSLock()

    static func seenFingerprint(for key: String) -> String? {
        seenLock.lock()
        defer { seenLock.unlock() }
        return lastSeen[key]
    }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        if SecTrustEvaluateWithError(trust, nil) {
            completionHandler(.performDefaultHandling, nil)
            return
        }
        let key = "\(challenge.protectionSpace.host):\(challenge.protectionSpace.port)"
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        let fingerprint = Self.fingerprint(leaf)
        Self.seenLock.lock()
        Self.lastSeen[key] = fingerprint
        Self.seenLock.unlock()
        if let pinned = pins[key], pinned.caseInsensitiveCompare(fingerprint) == .orderedSame {
            completionHandler(.useCredential, URLCredential(trust: trust))
        } else {
            completionHandler(.cancelAuthenticationChallenge, nil)
        }
    }

    /// Colon-separated upper-case hex, as `knode-os tls init` and openssl print it.
    static func fingerprint(_ certificate: SecCertificate) -> String {
        let der = SecCertificateCopyData(certificate) as Data
        return SHA256.hash(data: der).map { String(format: "%02X", $0) }.joined(separator: ":")
    }

    /// One URLSession per set of pins — also for none, so a first connection
    /// records the certificate it was shown.
    static func session(for pins: [String: String]) -> URLSession {
        let key = pins.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: ",")
        sessionLock.lock()
        defer { sessionLock.unlock() }
        if let cached = sessions[key] { return cached }
        let session = URLSession(configuration: .default, delegate: PinningDelegate(pins: pins), delegateQueue: nil)
        sessions[key] = session
        return session
    }

    nonisolated(unsafe) private static var sessions: [String: URLSession] = [:]
    private static let sessionLock = NSLock()
}
