import AppKit
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

    /// A self-signed certificate the app was shown and has not been told to trust.
    struct TrustPrompt: Equatable {
        var hostPort: String
        var fingerprint: String
    }

    @Published var phase: Phase = .signIn
    @Published var session: StoredSession?
    @Published var pendingUser: UserProfile?
    @Published var rememberSession = true
    /// The single source of navigation truth; the sidebar's section is derived
    /// from it. Set it through `select(_:)` so the section's last tab is kept.
    @Published private(set) var selectedTab: AppTab = .files
    @Published var stats: KnowledgeStats?
    /// Extraction, reviews and summaries: whether they run, and on what. Nil when the service has no labeling (a CLI-hosted app).
    @Published var processing: LabelingStatusResponse?
    @Published var connectionState: ConnectionState = .checking
    /// Where the service is and how to reach it.
    @Published private(set) var connection: ConnectionSettings
    /// What the sign-in screen says above the form: why you are seeing it again.
    @Published var authNotice: String?
    /// The service's answer before sign-in: whether it has accounts, and whether this Mac may make the first.
    @Published var authInfo: AuthState?
    /// The service's view of the signed-in account: role, groups usable from here, teams, gateways.
    @Published var account: AuthSnapshot?
    @Published var trustPrompt: TrustPrompt?
    @Published var pendingFilePath: String?
    /// An entity name the graph explores when it next appears; set by Entities → Explore in graph.
    @Published var pendingGraphQuery: String?
    /// What the search field (or an entity's "Search for it") hands Explore → Search to run.
    @Published var pendingSearch: String?
    /// A question for Explore → Ask: a new conversation sends it, or the composer holds it when Ask cannot answer.
    @Published var pendingQuestion: String?
    /// A topic for Explore → Research's composer. It waits there: refining spends a model call.
    @Published var pendingResearchTopic: String?
    /// A study or an Ask conversation Tasks → Queue asked to open.
    @Published var pendingStudyID: String?
    @Published var pendingConversationID: String?
    /// Bumped by ⌘K: the toolbar's search field takes the focus.
    @Published var topSearchFocusRequest = 0
    /// The last Explore → Search, so going to a file and back finds it still there. Not published: only that screen reads it.
    var lastExplore: ExploreMemory?
    /// The last Tasks → Queue read, shown at once when the screen comes back while the next one loads.
    var lastTasks: (workspaceID: String?, revision: Int, snapshot: TasksSnapshot)?
    /// The folder picked in the Files tree. Shared so Search can scope to it.
    @Published var pickedDirectory: String?
    @Published var workspaceRevision = 0
    /// Bumped by `reloadWorkspace`: the screen on show re-reads its data in place, keeping your place.
    @Published private(set) var reloadRequest = 0
    /// What the service says needs attention in the active workspace, less the ones dismissed here (`refreshNotices`).
    @Published private(set) var notices: [WorkspaceNotice] = []
    @Published var toastMessage: String?
    @Published var globalActivity: String?
    /// Interface language. Every view observes this model, so setting it
    /// redraws the whole app in the new language.
    @Published var language: AppLanguage = L10n.current {
        didSet { L10n.set(language) }
    }

    private let defaults: UserDefaults
    private let probeSession: URLSession?
    private var connectionCheckID = UUID()
    private let sessionKey = "knode-os.macos.session.v1"
    private let connectionKey = "knode-os.macos.connection.v1"
    /// Before connection modes: a single service URL.
    private let legacyServerKey = "knode-os.macos.server-url.v1"
    private let legacyAccountsKey = "knode-os.macos.accounts.v1"
    private let navKey = "knode-os.macos.nav.v1"
    /// Dismissed notices: service and workspace → notice kind → the key it had when dismissed.
    private let dismissedNoticesKey = "knode-os.macos.dismissed-notices.v1"
    private let localService = LocalServiceManager()
    private let tunnel = SSHTunnel()
    /// The session token for `connection`, from `SessionTokens` (or memory, when not remembered).
    private var token: String?
    /// The URL requests go to: the configured one, or the local end of the SSH tunnel.
    private var effectiveBaseURL: URL?
    private var toastTask: Task<Void, Never>?
    /// The account and workspace refresh in flight, and when the last one finished (`refreshAccess`).
    private var accessRefresh: Task<Void, Never>?
    private var lastAccessRefresh: Date?
    /// Where each section was left, so switching away and back does not lose your place.
    private var lastTab: [AppSection: AppTab] = [:]

    init(defaults: UserDefaults = .standard, connectsOnLaunch: Bool = true, probeSession: URLSession? = nil) {
        self.defaults = defaults
        self.probeSession = probeSession
        connection = Self.loadConnection(defaults, connectionKey: connectionKey, legacyKey: legacyServerKey)
        // the mock accounts of earlier builds had passwords hashed without salt: gone, never migrated
        defaults.removeObject(forKey: legacyAccountsKey)
        if let data = defaults.data(forKey: navKey), let nav = try? JSONDecoder().decode(NavState.self, from: data) {
            // A tab is remembered under the section it belongs to now: one that
            // moved (Search, from Library to Explore) follows, a section that is
            // gone (Ask, Research) leaves nothing behind, and its own section's
            // entry wins over a moved one.
            lastTab = nav.last.reduce(into: [:]) { out, pair in
                guard let tab = AppTab.named(pair.value) else { return }
                if AppSection(rawValue: pair.key) == tab.section || out[tab.section] == nil { out[tab.section] = tab }
            }
            if let tab = AppTab.named(nav.tab) {
                selectedTab = tab
                lastTab[tab.section] = tab
            }
        }
        token = SessionTokens.read(connection.identity)
        if let data = defaults.data(forKey: sessionKey),
           let stored = try? JSONDecoder().decode(StoredSession.self, from: data) {
            session = stored
            // a stored session is only as good as its token: without one, sign in again
            phase = token == nil ? .signIn : .app
        }
        if connectsOnLaunch {
            Task {
                await checkConnection(startBundled: true)
                if phase == .app {
                    await verifySession()
                    await refreshWorkspaces()
                    await refreshStats()
                }
            }
        }
    }

    var activeWorkspace: Workspace? {
        guard let session else { return nil }
        return session.workspaces.first(where: { $0.id == session.activeWorkspaceID }) ?? session.workspaces.first
    }

    var currentUser: UserProfile? { session?.user }

    /// What the sidebar shows for where the app is connected.
    var serverURLString: String { connection.summary }

    var isAdmin: Bool { account?.account.isAdmin ?? currentUser?.isAdmin ?? false }

    /// May the signed-in account change settings from where it is?
    var maySaveSettings: Bool { account?.groups?["settings"] ?? isAdmin }

    /// May it work with the workspace's files from where it is (sync a linked mirror, upload…)?
    var mayUseFiles: Bool { account?.groups?["files"] ?? true }

    func client() throws -> APIClient {
        guard let baseURL = effectiveBaseURL ?? Self.configuredURL(connection),
              let user = currentUser,
              let workspace = activeWorkspace else {
            throw APIError(message: "Choose a workspace before connecting")
        }
        return APIClient(baseURL: baseURL, username: user.username, workspace: workspace, token: token, urlSession: transportSession)
    }

    /// A client for the calls made before a workspace is chosen (sign-in, health).
    private func bareClient() throws -> APIClient {
        guard let baseURL = effectiveBaseURL ?? Self.configuredURL(connection) else { throw APIError(message: "Invalid service URL") }
        let fallback = Workspace(id: "default", name: "Default", kind: .personal)
        return APIClient(baseURL: baseURL, username: currentUser?.username ?? pendingUser?.username ?? "", workspace: activeWorkspace ?? fallback, token: token, urlSession: transportSession)
    }

    private var transportSession: URLSession {
        connection.mode == .remote ? PinningDelegate.session(for: connection.pinnedCertificates) : .shared
    }

    /* ----------------------------- connection ----------------------------- */

    private static func loadConnection(_ defaults: UserDefaults, connectionKey: String, legacyKey: String) -> ConnectionSettings {
        if let data = defaults.data(forKey: connectionKey), let saved = try? JSONDecoder().decode(ConnectionSettings.self, from: data) {
            return saved
        }
        var settings = ConnectionSettings()
        if let legacy = defaults.string(forKey: legacyKey), let url = URL(string: legacy), let host = url.host?.lowercased() {
            if ["127.0.0.1", "localhost", "::1"].contains(host) {
                settings.localURL = ConnectionSettings.trimmed(legacy)
            } else {
                settings.mode = .remote
                settings.remoteURL = ConnectionSettings.trimmed(legacy)
            }
        }
        return settings
    }

    private static func configuredURL(_ settings: ConnectionSettings) -> URL? {
        switch settings.mode {
        case .local: URL(string: ConnectionSettings.trimmed(settings.localURL))
        case .remote: URL(string: ConnectionSettings.trimmed(settings.remoteURL))
        case .ssh: nil
        }
    }

    /// Switch to other connection settings: a session belongs to one service, so another one asks you to sign in.
    func applyConnection(_ settings: ConnectionSettings) {
        var next = settings
        next.localURL = ConnectionSettings.trimmed(next.localURL)
        next.remoteURL = ConnectionSettings.trimmed(next.remoteURL)
        next.sshDestination = next.sshDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        let changedService = next.identity != connection.identity
        // Invalidate in-flight replies before publishing a different service.
        connectionCheckID = UUID()
        authInfo = nil
        connectionState = .checking
        connection = next
        if let data = try? JSONEncoder().encode(next) { defaults.set(data, forKey: connectionKey) }
        localService.stop()
        tunnel.stop()
        effectiveBaseURL = nil
        trustPrompt = nil
        if changedService {
            token = SessionTokens.read(next.identity)
            account = nil
            if token == nil, phase != .signIn {
                phase = .signIn
                authNotice = L("Sign in to the service you connected to.")
            }
        }
        Task {
            await checkConnection(startBundled: true)
            if phase == .app {
                await verifySession()
                await refreshWorkspaces()
                await refreshStats()
            }
        }
    }

    /// Trust the self-signed certificate the service showed, by its fingerprint.
    func trustPresentedCertificate() {
        guard let prompt = trustPrompt else { return }
        var next = connection
        next.pinnedCertificates[prompt.hostPort] = prompt.fingerprint
        trustPrompt = nil
        applyConnection(next)
    }

    /// Look for the service. `startBundled` lets the default local URL start the
    /// service bundled in the app when nothing answers — only when you connect,
    /// never on a periodic re-check. Another local URL is a service managed
    /// elsewhere (`ConnectionSettings.usesBundledService`), never started here.
    func checkConnection(startBundled: Bool = false) async {
        let checkID = UUID()
        connectionCheckID = checkID
        let settings = connection
        authInfo = nil
        connectionState = .checking
        do {
            let base = try await prepareTransport(settings, checkID: checkID, startBundled: startBundled)
            try requireCurrentCheck(checkID)
            let client = connectionProbe(base, settings: settings)
            let health = try await client.health()
            try requireCurrentCheck(checkID)
            let state = try await client.authState()
            try requireCurrentCheck(checkID)
            effectiveBaseURL = base
            authInfo = state
            connectionState = .connected(health.dataRoot)
        } catch {
            guard connectionCheckID == checkID else { return }
            authInfo = nil
            effectiveBaseURL = nil
            connectionState = .unavailable(describe(error))
        }
    }

    private func requireCurrentCheck(_ checkID: UUID) throws {
        guard checkID == connectionCheckID else { throw CancellationError() }
        try Task.checkCancellation()
    }

    /// Keep probes bound to the service they started with, even if the user
    /// changes connection while a response is in flight. No session is needed.
    private func connectionProbe(_ base: URL, settings: ConnectionSettings) -> APIClient {
        APIClient(baseURL: base, username: "", workspace: Workspace(id: "default", name: "Default", kind: .personal),
                  token: nil, urlSession: probeSession ?? (settings.mode == .remote ? PinningDelegate.session(for: settings.pinnedCertificates) : .shared))
    }

    /// Bring up what the connection needs and answer the base URL: the bundled
    /// service for a local URL nothing answers on, the SSH tunnel, or nothing.
    private func prepareTransport(_ settings: ConnectionSettings, checkID: UUID, startBundled: Bool) async throws -> URL {
        try requireCurrentCheck(checkID)
        switch settings.mode {
        case .local:
            guard let base = Self.configuredURL(settings), base.scheme != nil else { throw APIError(message: "Invalid service URL") }
            let client = connectionProbe(base, settings: settings)
            let health = try? await client.health()
            try requireCurrentCheck(checkID)
            if health != nil { return base }
            guard settings.usesBundledService, startBundled || localService.isRunning, try localService.start(for: base) else { return base }
            for _ in 0..<48 {
                try await Task.sleep(nanoseconds: 250_000_000)
                try requireCurrentCheck(checkID)
                let health = try? await client.health()
                try requireCurrentCheck(checkID)
                if health != nil { return base }
                if !localService.isRunning { break }
            }
            let log = localService.logURL?.path ?? "~/Library/Logs/knode-os/service.log"
            throw APIError(message: "The bundled service did not become ready. See \(log)")
        case .remote:
            guard let base = Self.configuredURL(settings), let scheme = base.scheme?.lowercased(), base.host != nil else {
                throw APIError(message: "Enter the service URL, e.g. https://knode.example.com")
            }
            guard scheme == "https" || scheme == "http" else { throw APIError(message: "The service URL starts with https://") }
            return base
        case .ssh:
            let port = try tunnel.start(settings)
            guard let base = URL(string: "http://127.0.0.1:\(port)") else { throw APIError(message: "Invalid tunnel address") }
            let client = connectionProbe(base, settings: settings)
            // ssh needs a moment to log in and open the forward
            for _ in 0..<60 {
                let health = try? await client.health()
                try requireCurrentCheck(checkID)
                if !tunnel.isRunning {
                    // Process exit and the stderr readability handler can race.
                    // Give the latter a moment to deliver a useful diagnosis.
                    if tunnel.lastError.isEmpty { try await Task.sleep(nanoseconds: 100_000_000) }
                    try requireCurrentCheck(checkID)
                    let said = tunnel.lastError
                    let status = tunnel.exitStatus.map(String.init) ?? "?"
                    tunnel.stop()
                    throw APIError(message: said.isEmpty ? L("SSH exited before the tunnel opened (status %@).", status) : "ssh: \(said)")
                }
                if health != nil { return base }
                try await Task.sleep(nanoseconds: 250_000_000)
                try requireCurrentCheck(checkID)
            }
            let said = tunnel.lastError
            tunnel.stop()
            throw APIError(message: said.isEmpty ? L("Nothing answered through the SSH tunnel — is knode-os running on that machine, on that port?") : "ssh: \(said)")
        }
    }

    /// Words for a failed connection, noticing an untrusted certificate on the way.
    private func describe(_ error: Error) -> String {
        let ns = error as NSError
        if connection.mode == .remote, ns.domain == NSURLErrorDomain,
           [NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorServerCertificateHasBadDate, NSURLErrorCancelled, NSURLErrorSecureConnectionFailed].contains(ns.code),
           let url = Self.configuredURL(connection), let host = url.host {
            let key = "\(host):\(url.port ?? 443)"
            if let seen = PinningDelegate.seenFingerprint(for: key) {
                if connection.pinnedCertificates[key] != nil {
                    trustPrompt = nil
                    return L("The service's certificate changed since you trusted it. If you replaced it on purpose, remove the old one under Connection and connect again.")
                }
                trustPrompt = TrustPrompt(hostPort: key, fingerprint: seen)
                return L("The service's certificate is not trusted by this Mac.")
            }
        }
        return error.localizedDescription
    }

    func shutdown() {
        connectionCheckID = UUID()
        localService.stop()
        tunnel.stop()
    }

    /* ------------------------------ sign-in ------------------------------ */

    private var deviceLabel: String {
        "\(Host.current().localizedName ?? "Mac") · knode-os app"
    }

    func signIn(username: String, password: String, remember: Bool) async -> String? {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !name.isEmpty else { return L("Enter your username.") }
        guard !password.isEmpty else { return L("Enter your password.") }
        if case .connected = connectionState {} else { await checkConnection(startBundled: true) }
        guard case .connected = connectionState else {
            if case .unavailable(let message) = connectionState { return message }
            return L("The service is not reachable.")
        }
        do {
            let view = try await bareClient().login(username: name, password: password, label: deviceLabel)
            accept(view, remember: remember)
            return nil
        } catch let error as APIError where error.reason == "setup" {
            await checkConnection()
            return L("This service has no accounts yet.")
        } catch {
            return error.localizedDescription
        }
    }

    /// The first account of a service on this Mac; the service refuses it from anywhere else.
    func createAdministrator(username: String, password: String, confirmation: String) async -> String? {
        guard case .connected = connectionState, authInfo?.setupRequired == true, authInfo?.canSetup == true else {
            return L("Connect to the service before creating an administrator.")
        }
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard name.range(of: "^[a-z0-9][a-z0-9._-]{0,31}$", options: .regularExpression) != nil else {
            return L("Use up to 32 lower-case letters, digits, dots, dashes or underscores.")
        }
        let minimum = authInfo?.minPasswordLength ?? 8
        guard password.count >= minimum else { return L("Passwords need at least %@ characters.", String(minimum)) }
        guard password == confirmation else { return L("The passwords do not match.") }
        do {
            let view = try await bareClient().setup(username: name, password: password, label: deviceLabel)
            accept(view, remember: true)
            authInfo?.setupRequired = false
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    /// The service accepted us: keep the token, and go back to the workspaces this Mac had open for the same user.
    private func accept(_ view: AuthSnapshot, remember: Bool) {
        guard let newToken = view.token else { return }
        token = newToken
        rememberSession = remember
        if remember { SessionTokens.save(newToken, for: connection.identity) } else { SessionTokens.delete(connection.identity) }
        account = view
        authNotice = nil
        let profile = UserProfile(username: view.account.username, name: view.account.name, role: view.account.role)
        if var stored = session, stored.user.username == profile.username {
            stored.user = profile
            stored.workspaces = stored.workspaces.filter { $0.kind == .personal } + allowedTeams(stored.workspaces.filter { $0.kind == .team })
            if !stored.workspaces.contains(where: { $0.id == stored.activeWorkspaceID }) { stored.activeWorkspaceID = "default" }
            setSession(stored)
            phase = .app
            workspaceRevision += 1
            Task {
                await refreshWorkspaces()
                await refreshStats()
            }
            return
        }
        // someone else signed in on this Mac: their workspaces are not ours
        defaults.removeObject(forKey: sessionKey)
        session = nil
        pendingUser = profile
        phase = .chooseWorkspace
    }

    /// Ask the service who we are; a session it no longer knows ends here.
    func verifySession() async {
        guard let asked = token else { return }
        do {
            let view = try await bareClient().me()
            // signed out, or in as someone else, while the answer was on its way
            guard token == asked else { return }
            account = view
            if var stored = session {
                stored.user.role = view.account.role
                stored.user.name = view.account.name
                setSession(stored)
            }
        } catch let error as APIError where error.sessionEnded {
            guard token == asked else { return }
            sessionEnded()
        } catch {
            // unreachable for now: the connection state says so already
        }
    }

    /// Ask again what this account may open, then refresh the workspace list. The Teams come
    /// with the account, which is otherwise read only at launch and sign-in. Without this, a
    /// Team shared or withdrawn while the app is open would not show until it was reopened.
    /// Calls that overlap share one round trip; `notWithin` skips a refresh made that recently.
    func refreshAccess(notWithin interval: TimeInterval = 0) async {
        if let running = accessRefresh {
            await running.value
            return
        }
        guard phase == .app, token != nil, case .connected = connectionState else { return }
        if let last = lastAccessRefresh, Date().timeIntervalSince(last) < interval { return }
        let task = Task { @MainActor in
            await verifySession()
            if phase == .app { await refreshWorkspaces() }
        }
        accessRefresh = task
        await task.value
        accessRefresh = nil
        lastAccessRefresh = Date()
    }

    /// The service no longer accepts our token: back to sign-in, keeping which workspaces were open.
    func sessionEnded(_ message: String? = nil) {
        guard phase != .signIn else { return }
        SessionTokens.delete(connection.identity)
        token = nil
        account = nil
        stats = nil
        processing = nil
        notices = []
        authNotice = message ?? L("Your session ended — sign in again.")
        phase = .signIn
    }

    func signOut() {
        let client = try? bareClient()
        if let client {
            Task { _ = try? await client.logout() }
        }
        SessionTokens.delete(connection.identity)
        token = nil
        account = nil
        defaults.removeObject(forKey: sessionKey)
        session = nil
        pendingUser = nil
        forgetHandOffs()
        stats = nil
        processing = nil
        notices = []
        authNotice = nil
        phase = .signIn
    }

    func goBackToSignIn() {
        if let client = try? bareClient() {
            Task { _ = try? await client.logout() }
        }
        pendingUser = nil
        SessionTokens.delete(connection.identity)
        token = nil
        account = nil
        phase = .signIn
    }

    /// A password change or "sign out others" hands back a new token for this Mac.
    func adopt(_ renewal: AuthRenewal) {
        guard let newToken = renewal.token else { return }
        token = newToken
        if rememberSession || SessionTokens.read(connection.identity) != nil { SessionTokens.save(newToken, for: connection.identity) }
    }

    /* ----------------------------- workspaces ----------------------------- */

    /// The Teams the service says this account may open.
    private var serverTeams: [Workspace] {
        (account?.teams ?? []).map { Workspace(id: $0.id, name: $0.name, kind: .team, code: $0.slug.uppercased()) }
    }

    /// Members keep only the Teams they were given; an administrator may keep any Team joined by code.
    private func allowedTeams(_ teams: [Workspace]) -> [Workspace] {
        let open = account == nil || isAdmin || account?.account.teams.contains("*") == true
        let given = serverTeams
        let kept = open ? teams : teams.filter { team in given.contains(where: { $0.id == team.id }) }
        var seen = Set<String>()
        return (kept + given).filter { seen.insert($0.id).inserted }
    }

    private func mayJoin(_ team: Workspace) -> Bool {
        guard let account, !account.account.isAdmin, !account.account.teams.contains("*") else { return true }
        return serverTeams.contains(where: { $0.id == team.id })
    }

    func startPersonalWorkspace() {
        guard pendingUser != nil else { return }
        let defaultWorkspace = Workspace(id: "default", name: "Default", kind: .personal)
        completeLogin(active: defaultWorkspace, workspaces: [defaultWorkspace])
    }

    func startTeamWorkspace(code: String) -> String? {
        guard pendingUser != nil else { return L("Sign in first.") }
        guard let team = team(from: code) else { return L("Enter a valid Team code or invite link.") }
        guard mayJoin(team) else { return L("Your account has not been given %@ — ask an administrator.", team.name) }
        let defaultWorkspace = Workspace(id: "default", name: "Default", kind: .personal)
        completeLogin(active: team, workspaces: [defaultWorkspace, team])
        return nil
    }

    func joinTeam(code: String) -> String? {
        guard var current = session else { return L("Sign in first.") }
        guard let team = team(from: code) else { return L("Enter a valid Team code or invite link.") }
        guard mayJoin(team) else { return L("Your account has not been given %@ — ask an administrator.", team.name) }
        if !current.workspaces.contains(where: { $0.id == team.id }) { current.workspaces.append(team) }
        current.activeWorkspaceID = team.id
        setSession(current)
        workspaceDidChange(message: "Joined \(team.name)")
        return nil
    }

    func switchWorkspace(to workspace: Workspace) {
        guard var current = session else { return }
        // picking the workspace already open reads it again
        guard current.activeWorkspaceID != workspace.id else {
            reloadWorkspace()
            showToast(L("Reloaded %@", workspace.displayName))
            return
        }
        current.activeWorkspaceID = workspace.id
        setSession(current)
        workspaceDidChange(message: "Switched to \(workspace.displayName)")
    }

    /// Read the open workspace again without losing your place: the counts in the toolbar, the
    /// notices, and what the screen on show re-reads when `reloadRequest` changes (Files: the
    /// open folders, and the open file unless it is being edited). Unlike Refresh Workspace (⌘R)
    /// nothing is rebuilt, so an open file, a search or a draft stays as it is.
    func reloadWorkspace() {
        reloadRequest += 1
        Task {
            await refreshStats()
            await refreshNotices()
        }
    }

    /// The workspace button: ask what this account may open, then read the open workspace again.
    /// A workspace that had to give way meanwhile (a Team withdrawn) opens fresh instead.
    func workspaceButtonClicked() async {
        let opened = activeWorkspace?.id
        await refreshAccess()
        if activeWorkspace?.id == opened { reloadWorkspace() }
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

    /// Files a browser shows as they are, and books, which Books opens: the file view shows what knode-os read out of them.
    static func hasOriginal(_ path: String) -> Bool {
        let originals: Set<String> = ["pdf", "html", "htm", "xhtml", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "tif", "tiff", "heic", "heif", "svg", "epub"]
        return originals.contains((path as NSString).pathExtension.lowercased())
    }

    /// An EPUB: read whole, with its chapters in a Contents menu.
    static func isBook(_ path: String) -> Bool {
        (path as NSString).pathExtension.lowercased() == "epub"
    }

    /// Open the file itself in the app that reads it (Preview, the browser),
    /// from a copy in the temporary folder: the PDF as it is, a web page as
    /// the service sends it, its script turned off.
    func openOriginal(_ path: String) async {
        do {
            let data = try await client().originalFile(at: path)
            // one folder per workspace file, so two files of the same name stay apart and a second open replaces the first copy
            let key = SHA256.hash(data: Data("\(activeWorkspace?.id ?? "")/\(path)".utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("KnodeOS Originals", isDirectory: true)
                .appendingPathComponent(key, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let copy = folder.appendingPathComponent((path as NSString).lastPathComponent)
            try data.write(to: copy, options: .atomic)
            if !NSWorkspace.shared.open(copy) { showToast(L("No app on this Mac opens %@", (path as NSString).lastPathComponent)) }
        } catch {
            showError(error, prefix: L("Open original failed"))
        }
    }

    /// A study as one HTML file, opened in the browser: from there it reads, saves, or prints to PDF.
    func openStudyExport(id: String, slug: String) async {
        do {
            let data = try await client().studyExport(id: id)
            // one folder per study and workspace, so a second export replaces the first copy
            let key = SHA256.hash(data: Data("\(activeWorkspace?.id ?? "")/\(id)".utf8)).prefix(8).map { String(format: "%02x", $0) }.joined()
            let folder = FileManager.default.temporaryDirectory
                .appendingPathComponent("KnodeOS Exports", isDirectory: true)
                .appendingPathComponent(key, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = slug.isEmpty ? id : slug
            let copy = folder.appendingPathComponent("\(name).html")
            try data.write(to: copy, options: .atomic)
            if !NSWorkspace.shared.open(copy) { showToast(L("No app on this Mac opens %@", "\(name).html")) }
        } catch {
            showError(error, prefix: L("Export failed"))
        }
    }

    func consumePendingFile() -> String? {
        defer { pendingFilePath = nil }
        return pendingFilePath
    }

    /// Show the local graph around an entity: the graph tab reads the name on its next load.
    func exploreEntity(_ name: String) {
        pendingGraphQuery = name
        select(.graph)
    }

    func consumePendingGraphQuery() -> String? {
        defer { pendingGraphQuery = nil }
        return pendingGraphQuery
    }

    /* ------------------- Explore: Search, Ask, Research ------------------- */

    /// Search for `query` in Explore → Search, from wherever it was asked.
    func runSearch(_ query: String) {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        pendingSearch = text
        select(.search)
    }

    /// Put a question to Ask: a new conversation, sent at once when Ask can answer.
    func ask(_ question: String) {
        let text = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        pendingQuestion = text
        select(.ask)
    }

    /// Take a topic to Research's composer. Nothing starts: refining spends a model call, so that stays a person's click.
    func research(_ topic: String) {
        let text = topic.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        pendingResearchTopic = text
        select(.studies)
    }

    func openStudy(_ id: String) {
        pendingStudyID = id
        select(.studies)
    }

    func openConversation(_ id: String) {
        pendingConversationID = id
        select(.ask)
    }

    func consumePendingSearch() -> String? {
        defer { pendingSearch = nil }
        return pendingSearch
    }

    func consumePendingQuestion() -> String? {
        defer { pendingQuestion = nil }
        return pendingQuestion
    }

    func consumePendingResearchTopic() -> String? {
        defer { pendingResearchTopic = nil }
        return pendingResearchTopic
    }

    func consumePendingStudy() -> String? {
        defer { pendingStudyID = nil }
        return pendingStudyID
    }

    func consumePendingConversation() -> String? {
        defer { pendingConversationID = nil }
        return pendingConversationID
    }

    /// ⌘K: the search field in the toolbar.
    func focusTopSearch() {
        topSearchFocusRequest += 1
    }

    /// What one workspace handed another screen: none of it applies in the next.
    private func forgetHandOffs() {
        pendingFilePath = nil
        pendingGraphQuery = nil
        pendingSearch = nil
        pendingQuestion = nil
        pendingResearchTopic = nil
        pendingStudyID = nil
        pendingConversationID = nil
        lastExplore = nil
        lastTasks = nil
    }

    /// Whether the service runs on this Mac, so a folder of this Mac is one it can read.
    /// Through an SSH tunnel the address is loopback but the service is not here.
    var serviceIsOnThisMac: Bool {
        let raw: String
        switch connection.mode {
        case .local: raw = connection.localURL
        case .remote: raw = connection.remoteURL
        case .ssh: return false
        }
        guard let host = URL(string: ConnectionSettings.trimmed(raw))?.host?.lowercased() else { return false }
        return ["127.0.0.1", "localhost", "::1", "[::1]"].contains(host)
    }

    func refreshStats() async {
        guard phase == .app else { return }
        do {
            stats = try await client().stats()
            processing = try? await client().labelingStatus()
            if case .connected = connectionState {} else { await checkConnection() }
        } catch let error as APIError where error.sessionEnded {
            sessionEnded()
        } catch {
            // the tunnel or the service went away: look again (and reopen the tunnel)
            await checkConnection()
        }
    }

    /* ------------------------------ notices ------------------------------ */

    /// The service and workspace a dismissal belongs to: the same workspace id on another service is another workspace.
    private var noticeScope: String? {
        guard let workspace = activeWorkspace else { return nil }
        return "\(connection.identity)#\(workspace.kind.rawValue)/\(workspace.id)"
    }

    private var dismissedNotices: [String: [String: String]] {
        defaults.dictionary(forKey: dismissedNoticesKey) as? [String: [String: String]] ?? [:]
    }

    /// Read the workspace's notices again. A dismissed one stays out until its key changes — a new lint report, other errors.
    func refreshNotices() async {
        guard phase == .app, let scope = noticeScope else { return }
        do {
            let all = try await client().notices().notices
            let dismissed = dismissedNotices[scope] ?? [:]
            notices = all.filter { dismissed[$0.id] != $0.key }
        } catch let error as APIError where error.sessionEnded {
            sessionEnded()
        } catch let error as APIError where error.status == 404 {
            // a service from before notices
            notices = []
        } catch {
            // unreachable for now: keep what is shown; the next refresh tries again
        }
    }

    func dismissNotice(_ notice: WorkspaceNotice) {
        guard let scope = noticeScope else { return }
        var all = dismissedNotices
        all[scope, default: [:]][notice.id] = notice.key
        defaults.set(all, forKey: dismissedNoticesKey)
        notices.removeAll { $0.id == notice.id }
    }

    /// Copy the agent sessions on the service's machine into the workspace,
    /// which lifts the pause a new or cleared workspace starts with.
    @discardableResult
    func collectTraces() async -> TraceSyncResponse? {
        globalActivity = L("Collecting traces…")
        defer { globalActivity = nil }
        do {
            let result = try await client().syncTraces()
            showToast(L("Collected %@ sessions · %@ skill files", String(result.copied), String(result.skills)))
            await refreshNotices()
            await refreshStats()
            return result
        } catch {
            showError(error, prefix: L("Collecting traces failed"))
            return nil
        }
    }

    /// Read every configured datasource again, for a notice about the last pass failing.
    func retryDatasources() async {
        globalActivity = L("Syncing datasources…")
        defer { globalActivity = nil }
        do {
            let result = try await client().syncDatasources()
            showToast(result.errors.isEmpty ? L("Datasources synced") : L("Datasources synced with %@ errors", String(result.errors.count)))
            await refreshNotices()
        } catch {
            showError(error, prefix: L("Datasource sync failed"))
        }
    }

    /// Start or stop the workspace's processing; the service refuses anyone but an administrator.
    func setProcessing(_ running: Bool) async {
        do {
            let answer = try await client().setProcessing(running)
            processing?.processing = answer.processing
            showToast(running ? L("Processing started") : L("Processing stopped — calls in flight finish"))
            processing = try? await client().labelingStatus()
        } catch {
            showError(error)
        }
    }

    func refreshWorkspaces() async {
        guard let asked = session?.user.username else { return }
        do {
            let owned = try await client().workspaces()
            // Read the session after the answer: a workspace picked meanwhile stays picked,
            // and someone else's sign-in meanwhile is not given these workspaces.
            guard var current = session, current.user.username == asked else { return }
            let teams = allowedTeams(current.workspaces.filter { $0.kind == .team })
            let merged = owned + teams.filter { team in !owned.contains(where: { $0.id == team.id }) }
            let previousActiveID = current.activeWorkspaceID
            current.workspaces = merged
            if !merged.contains(where: { $0.id == current.activeWorkspaceID }),
               let fallback = owned.first ?? teams.first {
                current.activeWorkspaceID = fallback.id
            }
            setSession(current)
            if previousActiveID != current.activeWorkspaceID {
                forgetHandOffs()
                stats = nil
                processing = nil
                notices = []
                workspaceRevision += 1
            }
        } catch let error as APIError where error.sessionEnded {
            sessionEnded()
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
        if let apiError = error as? APIError, apiError.sessionEnded {
            sessionEnded()
            return
        }
        showToast([prefix, error.localizedDescription].compactMap { $0 }.joined(separator: ": "), duration: 5_000_000_000)
    }

    private func completeLogin(active: Workspace, workspaces: [Workspace]) {
        guard let pendingUser else { return }
        let personal = workspaces.filter { $0.kind == .personal }
        let newSession = StoredSession(user: pendingUser, workspaces: personal + allowedTeams(workspaces.filter { $0.kind == .team }), activeWorkspaceID: active.id)
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
        forgetHandOffs()
        stats = nil
        processing = nil
        notices = []
        workspaceRevision += 1
        showToast(message)
        Task {
            await refreshStats()
        }
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
