import CryptoKit
import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum Phase {
        case signIn
        case chooseWorkspace
        case app
    }

    enum ConnectionState: Equatable {
        case checking
        case connected(String?)
        case unavailable(String)
    }

    @Published var phase: Phase = .signIn
    @Published var session: StoredSession?
    @Published var pendingUser: UserProfile?
    @Published var rememberSession = true
    /// The single source of navigation truth; the sidebar's section is derived
    /// from it. Set it through `select(_:)` so the section's last tab is kept.
    @Published private(set) var selectedTab: AppTab = .files
    @Published var stats: KnowledgeStats?
    @Published var connectionState: ConnectionState = .checking
    @Published var serverURLString: String
    @Published var pendingFilePath: String?
    /// The folder picked in the Files tree. Shared so Search can scope to it.
    @Published var pickedDirectory: String?
    @Published var workspaceRevision = 0
    @Published var toastMessage: String?
    @Published var globalActivity: String?
    /// Interface language. Every view observes this model, so setting it
    /// redraws the whole app in the new language.
    @Published var language: AppLanguage = L10n.current {
        didSet { L10n.set(language) }
    }

    private let defaults = UserDefaults.standard
    private let sessionKey = "knode-os.macos.session.v1"
    private let accountsKey = "knode-os.macos.accounts.v1"
    private let serverKey = "knode-os.macos.server-url.v1"
    private let navKey = "knode-os.macos.nav.v1"
    private let localService = LocalServiceManager()
    private var toastTask: Task<Void, Never>?
    /// Where each section was left, so switching away and back does not lose your place.
    private var lastTab: [AppSection: AppTab] = [:]

    init() {
        serverURLString = defaults.string(forKey: serverKey) ?? "http://127.0.0.1:9100"
        if let data = defaults.data(forKey: navKey), let nav = try? JSONDecoder().decode(NavState.self, from: data) {
            lastTab = nav.last.reduce(into: [:]) { out, pair in
                if let section = AppSection(rawValue: pair.key), let tab = AppTab.named(pair.value) { out[section] = tab }
            }
            if let tab = AppTab.named(nav.tab) { selectedTab = tab }
        }
        if let data = defaults.data(forKey: sessionKey),
           let stored = try? JSONDecoder().decode(StoredSession.self, from: data) {
            session = stored
            phase = .app
        }
        Task {
            await checkConnection()
            if phase == .app {
                await refreshWorkspaces()
                await refreshStats()
            }
        }
    }

    var activeWorkspace: Workspace? {
        guard let session else { return nil }
        return session.workspaces.first(where: { $0.id == session.activeWorkspaceID }) ?? session.workspaces.first
    }

    var currentUser: UserProfile? { session?.user }

    func client() throws -> APIClient {
        guard let baseURL = URL(string: serverURLString),
              let user = currentUser,
              let workspace = activeWorkspace else {
            throw APIError(message: "Choose a workspace before connecting")
        }
        return APIClient(baseURL: baseURL, username: user.username, workspace: workspace)
    }

    func applyServerURL() {
        let trimmed = serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)
        serverURLString = trimmed.hasSuffix("/") ? String(trimmed.dropLast()) : trimmed
        defaults.set(serverURLString, forKey: serverKey)
        localService.stop()
        Task {
            await checkConnection()
            if phase == .app {
                await refreshWorkspaces()
                await refreshStats()
            }
        }
    }

    func checkConnection() async {
        connectionState = .checking
        guard let baseURL = URL(string: serverURLString) else {
            connectionState = .unavailable("Invalid URL")
            return
        }
        let fallback = Workspace(id: "default", name: "Default", kind: .personal)
        let client = APIClient(
            baseURL: baseURL,
            username: currentUser?.username ?? "admin",
            workspace: activeWorkspace ?? fallback
        )
        do {
            let health = try await client.health()
            connectionState = .connected(health.dataRoot)
        } catch {
            let originalError = error
            do {
                guard try localService.start(for: baseURL) else {
                    connectionState = .unavailable(originalError.localizedDescription)
                    return
                }
                for _ in 0..<48 {
                    try? await Task.sleep(nanoseconds: 250_000_000)
                    do {
                        let health = try await client.health()
                        connectionState = .connected(health.dataRoot)
                        return
                    } catch {
                        if !localService.isRunning { break }
                    }
                }
                let log = localService.logURL?.path ?? "~/Library/Logs/knode-os/service.log"
                connectionState = .unavailable("The bundled service did not become ready. See \(log)")
            } catch {
                connectionState = .unavailable(error.localizedDescription)
            }
        }
    }

    func shutdown() {
        localService.stop()
    }

    func signIn(username: String, password: String, remember: Bool) -> String? {
        let normalized = normalizeUsername(username)
        guard !normalized.isEmpty else { return "Enter your username." }

        let builtin: [String: (password: String, name: String)] = [
            "admin": ("admin", "Admin"),
            "test": ("test", "Test"),
        ]
        let profile: UserProfile?
        if let account = builtin[normalized], account.password == password {
            profile = UserProfile(username: normalized, name: account.name)
        } else if let account = localAccounts().first(where: { $0.username == normalized }),
                  account.passwordHash == hash(password) {
            profile = UserProfile(username: account.username, name: account.name)
        } else {
            profile = nil
        }
        guard let profile else { return "Invalid username or password." }

        pendingUser = profile
        rememberSession = remember
        phase = .chooseWorkspace
        return nil
    }

    func register(username: String, password: String, confirmation: String) -> String? {
        let raw = username.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalized = normalizeUsername(raw)
        let allowed = raw.range(of: "^[a-zA-Z0-9._-]{3,32}$", options: .regularExpression) != nil
        guard allowed else { return "Use 3–32 letters, numbers, dots, dashes or underscores." }
        guard !["admin", "test"].contains(normalized),
              !localAccounts().contains(where: { $0.username == normalized }) else {
            return "That username already exists."
        }
        guard password.count >= 4 else { return "Password must be at least 4 characters." }
        guard password == confirmation else { return "Passwords do not match." }

        var accounts = localAccounts()
        accounts.append(LocalAccount(username: normalized, name: displayName(from: normalized), passwordHash: hash(password)))
        if let data = try? JSONEncoder().encode(accounts) { defaults.set(data, forKey: accountsKey) }
        pendingUser = UserProfile(username: normalized, name: displayName(from: normalized))
        rememberSession = true
        phase = .chooseWorkspace
        return nil
    }

    func startPersonalWorkspace() {
        guard pendingUser != nil else { return }
        let defaultWorkspace = Workspace(id: "default", name: "Default", kind: .personal)
        completeLogin(active: defaultWorkspace, workspaces: [defaultWorkspace])
    }

    func startTeamWorkspace(code: String) -> String? {
        guard pendingUser != nil else { return "Sign in first." }
        guard let team = team(from: code) else { return "Enter a valid Team code or invite link." }
        let defaultWorkspace = Workspace(id: "default", name: "Default", kind: .personal)
        completeLogin(active: team, workspaces: [defaultWorkspace, team])
        return nil
    }

    func joinTeam(code: String) -> String? {
        guard var current = session else { return "Sign in first." }
        guard let team = team(from: code) else { return "Enter a valid Team code or invite link." }
        if !current.workspaces.contains(where: { $0.id == team.id }) { current.workspaces.append(team) }
        current.activeWorkspaceID = team.id
        setSession(current)
        workspaceDidChange(message: "Joined \(team.name)")
        return nil
    }

    func switchWorkspace(to workspace: Workspace) {
        guard var current = session, current.activeWorkspaceID != workspace.id else { return }
        current.activeWorkspaceID = workspace.id
        setSession(current)
        workspaceDidChange(message: "Switched to \(workspace.displayName)")
    }

    func createWorkspace(named name: String) async throws {
        guard var current = session else { throw APIError(message: "Sign in first.") }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw APIError(message: "Enter a workspace name.") }
        let workspace = try await client().createWorkspace(name: trimmed)
        current.workspaces.removeAll(where: { $0.kind == .personal && $0.id == workspace.id })
        current.workspaces.append(workspace)
        current.activeWorkspaceID = workspace.id
        setSession(current)
        workspaceDidChange(message: "Created \(workspace.displayName)")
    }

    func clearActiveWorkspace() async throws {
        guard let workspace = activeWorkspace else { throw APIError(message: "Choose a workspace first.") }
        globalActivity = "Clearing \(workspace.displayName)…"
        defer { globalActivity = nil }
        _ = try await client().clearWorkspace()
        workspaceDidChange(message: "\(workspace.displayName) was completely cleared")
    }

    func signOut() {
        defaults.removeObject(forKey: sessionKey)
        session = nil
        pendingUser = nil
        pendingFilePath = nil
        stats = nil
        phase = .signIn
    }

    func goBackToSignIn() {
        pendingUser = nil
        phase = .signIn
    }

    /* --------------------------- navigation ------------------------------ */

    /// Which sidebar row is lit; there is no separate stored section.
    var selectedSection: AppSection { selectedTab.section }

    func select(_ tab: AppTab) {
        guard tab != selectedTab else { return }
        selectedTab = tab
        lastTab[tab.section] = tab
        persistNav()
    }

    /// Picking a section returns to the tab last used there, not to its first one.
    func select(section: AppSection) {
        select(lastTab[section] ?? section.tabs.first ?? .files)
    }

    private struct NavState: Codable {
        var tab: String
        var last: [String: String]
    }

    private func persistNav() {
        let nav = NavState(tab: selectedTab.rawValue, last: lastTab.reduce(into: [:]) { out, pair in out[pair.key.rawValue] = pair.value.rawValue })
        if let data = try? JSONEncoder().encode(nav) { defaults.set(data, forKey: navKey) }
    }

    func openFile(_ path: String) {
        pendingFilePath = path
        select(.files)
    }

    func consumePendingFile() -> String? {
        defer { pendingFilePath = nil }
        return pendingFilePath
    }

    func refreshStats() async {
        do {
            stats = try await client().stats()
            if case .unavailable = connectionState { await checkConnection() }
        } catch {
            connectionState = .unavailable(error.localizedDescription)
        }
    }

    func refreshWorkspaces() async {
        guard var current = session else { return }
        do {
            let owned = try await client().workspaces()
            let teams = current.workspaces.filter { $0.kind == .team }
            let merged = owned + teams.filter { team in !owned.contains(where: { $0.id == team.id }) }
            let previousActiveID = current.activeWorkspaceID
            current.workspaces = merged
            if !merged.contains(where: { $0.id == current.activeWorkspaceID }),
               let fallback = owned.first ?? teams.first {
                current.activeWorkspaceID = fallback.id
            }
            setSession(current)
            if previousActiveID != current.activeWorkspaceID {
                pendingFilePath = nil
                stats = nil
                workspaceRevision += 1
            }
        } catch {
            // Existing sessions remain usable if an older external service does
            // not expose workspace lifecycle APIs yet.
        }
    }

    func showToast(_ message: String, duration: UInt64 = 2_600_000_000) {
        toastTask?.cancel()
        toastMessage = message
        toastTask = Task {
            try? await Task.sleep(nanoseconds: duration)
            if !Task.isCancelled { toastMessage = nil }
        }
    }

    func showError(_ error: Error, prefix: String? = nil) {
        showToast([prefix, error.localizedDescription].compactMap { $0 }.joined(separator: ": "), duration: 5_000_000_000)
    }

    private func completeLogin(active: Workspace, workspaces: [Workspace]) {
        guard let pendingUser else { return }
        let newSession = StoredSession(user: pendingUser, workspaces: workspaces, activeWorkspaceID: active.id)
        session = newSession
        if rememberSession, let data = try? JSONEncoder().encode(newSession) {
            defaults.set(data, forKey: sessionKey)
        } else {
            defaults.removeObject(forKey: sessionKey)
        }
        self.pendingUser = nil
        phase = .app
        workspaceRevision += 1
        Task {
            await checkConnection()
            await refreshWorkspaces()
            await refreshStats()
        }
    }

    private func setSession(_ value: StoredSession) {
        session = value
        if rememberSession || defaults.data(forKey: sessionKey) != nil,
           let data = try? JSONEncoder().encode(value) {
            defaults.set(data, forKey: sessionKey)
        }
    }

    private func workspaceDidChange(message: String) {
        pendingFilePath = nil
        stats = nil
        workspaceRevision += 1
        showToast(message)
        Task {
            await checkConnection()
            await refreshStats()
        }
    }

    private func localAccounts() -> [LocalAccount] {
        guard let data = defaults.data(forKey: accountsKey) else { return [] }
        return (try? JSONDecoder().decode([LocalAccount].self, from: data)) ?? []
    }

    private func hash(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private func normalizeUsername(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private func displayName(from username: String) -> String {
        username
            .split(whereSeparator: { $0 == "." || $0 == "_" || $0 == "-" })
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    private func team(from rawCode: String) -> Workspace? {
        var code = rawCode.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: code), let host = url.host, !host.isEmpty {
            code = url.pathComponents.last ?? ""
        }
        code = code.uppercased().filter { $0.isLetter || $0.isNumber || $0 == "-" }
        guard code.replacingOccurrences(of: "-", with: "").count >= 3 else { return nil }
        let name = code.split(separator: "-").map { word in
            word.prefix(1) + word.dropFirst().lowercased()
        }.joined(separator: " ")
        return Workspace(id: "team-\(code.lowercased())", name: name.isEmpty ? "Shared Team" : name, kind: .team, code: code)
    }
}
