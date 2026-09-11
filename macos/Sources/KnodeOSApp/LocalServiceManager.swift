import Foundation

struct LocalServiceError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Owns the Node service bundled inside the packaged macOS app. External and
/// remote service URLs are never launched or terminated by the app.
final class LocalServiceManager {
    private var process: Process?
    private var logHandle: FileHandle?

    private(set) var logURL: URL?

    var isRunning: Bool { process?.isRunning == true }

    /// Starts the bundled service for a loopback HTTP URL. Returns false when
    /// the selected URL is remote and must therefore be managed externally.
    @discardableResult
    func start(for baseURL: URL) throws -> Bool {
        guard Self.isLoopbackHTTP(baseURL) else { return false }
        if isRunning { return true }

        let fileManager = FileManager.default
        guard let resources = Bundle.main.resourceURL else {
            throw LocalServiceError(message: "The app resources directory is unavailable")
        }
        let serviceRoot = resources.appendingPathComponent("KnodeService/app", isDirectory: true)
        let nodeURL = resources.appendingPathComponent("KnodeService/bin/node", isDirectory: false)
        let cliURL = serviceRoot.appendingPathComponent("dist/cli.js", isDirectory: false)
        guard fileManager.isExecutableFile(atPath: nodeURL.path),
              fileManager.fileExists(atPath: cliURL.path) else {
            throw LocalServiceError(message: "This app build does not include the local service. Rebuild it with macos/scripts/package-app.sh or start knode-os serve manually.")
        }

        let port = baseURL.port ?? 80
        guard port >= 1 && port <= 65_535 else {
            throw LocalServiceError(message: "The service URL has an invalid port")
        }

        let logsDirectory = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/knode-os", isDirectory: true)
        try fileManager.createDirectory(at: logsDirectory, withIntermediateDirectories: true)
        let logURL = logsDirectory.appendingPathComponent("service.log", isDirectory: false)
        if !fileManager.fileExists(atPath: logURL.path) {
            fileManager.createFile(atPath: logURL.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: logURL)
        try handle.seekToEnd()
        let marker = "\n[macOS app] starting local service at \(ISO8601DateFormatter().string(from: Date()))\n"
        try handle.write(contentsOf: Data(marker.utf8))

        let task = Process()
        task.executableURL = nodeURL
        task.arguments = [cliURL.path, "serve", "--port", String(port)]
        task.currentDirectoryURL = serviceRoot
        task.standardOutput = handle
        task.standardError = handle

        var environment = ProcessInfo.processInfo.environment
        environment["KNODE_OS_DESKTOP"] = "1"
        environment["PATH"] = executableSearchPath(resources: resources, inherited: environment["PATH"])
        task.environment = environment

        do {
            try task.run()
        } catch {
            try? handle.close()
            throw LocalServiceError(message: "Could not start the bundled service: \(error.localizedDescription)")
        }

        process = task
        logHandle = handle
        self.logURL = logURL
        return true
    }

    func stop() {
        let processToStop = process
        let handleToClose = logHandle
        process = nil
        logHandle = nil

        guard let processToStop, processToStop.isRunning else {
            try? handleToClose?.close()
            return
        }

        processToStop.terminationHandler = { _ in
            try? handleToClose?.close()
        }
        processToStop.terminate()
    }

    private static func isLoopbackHTTP(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return false }
        return host == "127.0.0.1" || host == "localhost" || host == "::1" || host == "[::1]"
    }

    private func executableSearchPath(resources: URL, inherited: String?) -> String {
        let fileManager = FileManager.default
        let home = fileManager.homeDirectoryForCurrentUser
        var directories = [
            resources.appendingPathComponent("KnodeService/bin").path,
            home.appendingPathComponent(".local/bin").path,
            home.appendingPathComponent(".volta/bin").path,
            home.appendingPathComponent(".bun/bin").path,
            home.appendingPathComponent(".cargo/bin").path,
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]

        let nvmVersions = home.appendingPathComponent(".nvm/versions/node", isDirectory: true)
        if let versions = try? fileManager.contentsOfDirectory(at: nvmVersions, includingPropertiesForKeys: nil) {
            directories.insert(contentsOf: versions.sorted { $0.lastPathComponent > $1.lastPathComponent }.map { $0.appendingPathComponent("bin").path }, at: 1)
        }
        if let inherited { directories.append(contentsOf: inherited.split(separator: ":").map(String.init)) }
        return Array(NSOrderedSet(array: directories))
            .compactMap { $0 as? String }
            .joined(separator: ":")
    }
}
