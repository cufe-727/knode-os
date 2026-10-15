import Darwin
import Foundation

/// Discovers literal Host aliases only. OpenSSH still evaluates the connection's
/// settings, including Match, ProxyJump and identities. Discovery never runs
/// `ssh -G`, which can execute a user's Match exec commands.
enum SSHConfig {
    struct Hosts {
        var names: [String] = []
        var unreadableFiles: [String] = []
    }

    static func hosts(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> Hosts {
        let directory = home.appendingPathComponent(".ssh")
        var result = Hosts()
        var visited = Set<String>()
        var names = Set<String>()

        func read(_ file: URL, depth: Int) {
            let path = file.resolvingSymlinksInPath().standardizedFileURL.path
            guard depth < 16, visited.insert(path).inserted else { return }
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else {
                result.unreadableFiles.append(path)
                return
            }
            for line in text.components(separatedBy: .newlines) {
                let parts = tokens(line)
                guard let keyword = parts.first?.lowercased() else { continue }
                let values = parts.dropFirst().drop(while: { $0 == "=" })
                switch keyword {
                case "host":
                    for name in values where !name.isEmpty && !name.hasPrefix("-")
                        && !name.contains(where: { "*?!".contains($0) || $0.isWhitespace }) {
                        if names.insert(name).inserted { result.names.append(name) }
                    }
                case "include":
                    for value in values {
                        var pattern = value.replacingOccurrences(of: "%d", with: home.path)
                        for (key, value) in ProcessInfo.processInfo.environment {
                            pattern = pattern.replacingOccurrences(of: "${\(key)}", with: value)
                        }
                        if pattern.hasPrefix("~/") { pattern = home.path + pattern.dropFirst() }
                        else { pattern = (pattern as NSString).expandingTildeInPath }
                        if !pattern.hasPrefix("/") { pattern = directory.appendingPathComponent(pattern).path }
                        var matches = glob_t()
                        defer { globfree(&matches) }
                        guard glob(pattern, 0, nil, &matches) == 0, let paths = matches.gl_pathv else { continue }
                        for index in 0..<Int(matches.gl_pathc) {
                            if let path = paths[index] { read(URL(fileURLWithPath: String(cString: path)), depth: depth + 1) }
                        }
                    }
                default: break
                }
            }
        }

        let file = directory.appendingPathComponent("config")
        if FileManager.default.fileExists(atPath: file.path) { read(file, depth: 0) }
        result.names.sort { $0.localizedStandardCompare($1) == .orderedAscending }
        return result
    }

    /// SSH config accepts Keyword=value, quoted arguments and trailing comments.
    private static func tokens(_ line: String) -> [String] {
        var result: [String] = []
        var token = ""
        var quote: Character?
        var escaped = false
        for character in line {
            if escaped { token.append(character); escaped = false; continue }
            if character == "\\" { escaped = true; continue }
            if let delimiter = quote {
                if character == delimiter { quote = nil } else { token.append(character) }
            } else if character == "\"" || character == "'" {
                quote = character
            } else if character == "#" {
                break
            } else if character.isWhitespace || (character == "=" && (result.isEmpty || (result.count == 1 && token.isEmpty))) {
                if !token.isEmpty { result.append(token); token = "" }
            } else {
                token.append(character)
            }
        }
        if !token.isEmpty { result.append(token) }
        return result
    }
}
