import SwiftUI

/// Account & access: your password and sessions, and — for an administrator —
/// the users of the service and the local services it publishes under /gw.
/// The service enforces all of it (src/auth); this screen draws what it says.
struct AccessView: View {
    @EnvironmentObject private var model: AppModel
    @State private var me: AuthSnapshot?
    @State private var sessions: [AuthSessionRow] = []
    @State private var users: AdminUsersResponse?
    @State private var gateways: [GatewayRecord] = []
    @State private var current = ""
    @State private var newPassword = ""
    @State private var confirmation = ""
    @State private var passwordMessage = ""
    @State private var passwordFailed = false
    @State private var editing: UserEditor?
    @State private var gatewayID = ""
    @State private var gatewayTarget = ""
    @State private var gatewayDescription = ""
    @State private var gatewaySandbox = true
    @State private var gatewayError = ""
    @State private var userToRemove: String?

    private static let groupTitles: [String: String] = [
        "files": "Files", "search": "Search", "ask": "Ask", "knowledge": "Knowledge", "ingest": "Ingest",
        "traces": "Traces", "datasources": "Datasources", "settings": "Settings", "gateway": "Gateways",
    ]
    static let groupOrder = ["files", "search", "ask", "knowledge", "ingest", "traces", "datasources", "settings", "gateway"]

    var body: some View {
        VStack(spacing: 0) {
            SectionTabs(section: .settings) { EmptyView() }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    accountSection
                    if me?.account.isAdmin == true, me?.groups?["settings"] == true {
                        usersSection
                        gatewaysSection
                    }
                }
                .padding(24)
                .frame(maxWidth: 1000, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        }
        .task { await load() }
        .sheet(item: $editing) { editor in
            UserEditorSheet(editor: editor, apiGroups: users?.apiGroups ?? [:]) { draft, username in
                try await save(draft, username: username)
            }
            .environmentObject(model)
        }
        .confirmationDialog(
            L("Remove %@?", userToRemove ?? ""),
            isPresented: Binding(get: { userToRemove != nil }, set: { if !$0 { userToRemove = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Remove"), role: .destructive) {
                guard let name = userToRemove else { return }
                userToRemove = nil
                Task { await removeUser(name) }
            }
            Button(L("Cancel"), role: .cancel) { userToRemove = nil }
        } message: {
            Text(L("Their sessions end. Their workspaces stay on disk under users/<name>."))
        }
    }

    // MARK: - your account

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Account")).font(.title3.bold())
                if let account = me?.account {
                    Text(L("Signed in as %@ (@%@), %@.", account.name, account.username, me?.local == true ? L("on the machine the service runs on") : L("from another machine")))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    Text(L("Change password")).font(.headline)
                    SecureField(L("Current password"), text: $current).textContentType(.password)
                    SecureField(L("New password"), text: $newPassword).textContentType(.newPassword)
                    SecureField(L("Confirm new password"), text: $confirmation).textContentType(.newPassword)
                    if !passwordMessage.isEmpty {
                        Text(passwordMessage).font(.caption).foregroundStyle(passwordFailed ? Color.knodeBad : Color.knodeGood)
                    }
                    HStack {
                        Text(L("Every other session of yours ends.")).font(.caption).foregroundStyle(.secondary)
                        Spacer()
                        Button(L("Change password")) { Task { await changePassword() } }
                            .buttonStyle(.borderedProminent)
                            .tint(.knodeCyan)
                            .disabled(current.isEmpty || newPassword.isEmpty)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: 360)
                .knodeCard()

                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        Text(L("Signed-in sessions")).font(.headline)
                        Spacer()
                        Button(L("Sign out others")) { Task { await signOutOthers() } }
                    }
                    ForEach(sessions) { session in
                        HStack(alignment: .top) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(session.label).font(.callout.weight(.medium))
                                    if session.current == true {
                                        Text(L("this one")).font(.caption2.weight(.semibold)).foregroundStyle(Color.knodeCyan)
                                    }
                                }
                                Text("\(session.kind) · \(L("last used")) \(Self.when(session.lastSeenAt))\(session.ip.map { " · \($0)" } ?? "")")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                            if session.current != true {
                                Button(L("End")) { Task { await endSession(session.id) } }
                            }
                        }
                    }
                    Divider()
                    Text(L("What you may use from here")).font(.headline)
                    FlowChips(items: Self.groupOrder.compactMap { group in
                        guard let allowed = me?.groups?[group] else { return nil }
                        return (L(Self.groupTitles[group] ?? group), allowed)
                    })
                    if let mine = me?.gateways, !mine.isEmpty {
                        Divider()
                        Text(L("Gateways you may use")).font(.headline)
                        ForEach(mine) { gateway in
                            Text("\(gateway.path)  \(gateway.description)").font(.caption.monospaced())
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .knodeCard()
            }
        }
    }

    // MARK: - users (administrators)

    private var usersSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Users of this service")).font(.title3.bold())
                    Text(L("Members open their own workspaces and the Teams listed for them, and never settings. From other machines an account may use only the API groups ticked for it. Ask and Research run coding agents on the service's machine — give them only to people you trust with it."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer()
                Button(L("Add user")) { editing = UserEditor(user: nil, isSelf: false) }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
            }
            VStack(spacing: 0) {
                ForEach(users?.users ?? []) { user in
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 6) {
                                Text(user.username).font(.callout.weight(.semibold))
                                Text(user.role == "admin" ? L("administrator") : L("member")).font(.caption).foregroundStyle(.secondary)
                                if user.disabled == true { Text(L("disabled")).font(.caption).foregroundStyle(Color.knodeBad) }
                            }
                            Text(summary(user)).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                        Spacer()
                        Text(L("%@ sessions", String(user.sessions.count))).font(.caption).foregroundStyle(.secondary)
                        Button(L("Edit")) { editing = UserEditor(user: user, isSelf: user.username == me?.account.username) }
                        if user.username != me?.account.username {
                            Button(L("Sign out")) { Task { await signOutUser(user.username) } }
                                .disabled(user.sessions.count == 0)
                            Button(L("Remove"), role: .destructive) { userToRemove = user.username }
                        }
                    }
                    .padding(.vertical, 9)
                    .padding(.horizontal, 12)
                    Divider()
                }
            }
            .knodeCard(padding: 0)
        }
    }

    private func summary(_ user: AdminUser) -> String {
        let teams = user.role == "admin" ? L("all Teams") : (user.teams.isEmpty ? L("no Teams") : user.teams.joined(separator: ", "))
        let remote = user.remoteApis.contains("*") ? L("everything") : (user.remoteApis.isEmpty ? L("nothing") : user.remoteApis.map { L(Self.groupTitles[$0] ?? $0) }.joined(separator: ", "))
        let gateways = user.role == "admin" ? L("all gateways") : (user.gateways.isEmpty ? L("no gateways") : user.gateways.joined(separator: ", "))
        return "\(teams) · \(L("from other machines")): \(remote) · \(gateways)"
    }

    // MARK: - gateways (administrators)

    private var gatewaysSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Local services, published under /gw")).font(.title3.bold())
                Text(L("A signed-in account allowed a gateway reaches the service at /gw/<id>/… — knode credentials stay here and the service sees X-Knode-User. Targets must be on the service's machine."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(spacing: 0) {
                ForEach(gateways) { gateway in
                    HStack(spacing: 12) {
                        Text("/gw/\(gateway.id)/").font(.callout.monospaced())
                        Text("→ \(gateway.target)").font(.caption.monospaced()).foregroundStyle(.secondary)
                        if gateway.sandbox == false { Text(L("unsandboxed")).font(.caption).foregroundStyle(Color.knodeBad) }
                        Text(gateway.description ?? "").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        Spacer()
                        Button(L("Remove"), role: .destructive) { Task { await removeGateway(gateway.id) } }
                    }
                    .padding(.vertical, 9)
                    .padding(.horizontal, 12)
                    Divider()
                }
                HStack(spacing: 8) {
                    TextField(L("id, e.g. homebook"), text: $gatewayID).frame(width: 150)
                    TextField("http://127.0.0.1:12200/api", text: $gatewayTarget)
                    TextField(L("description (optional)"), text: $gatewayDescription)
                    Toggle(L("sandboxed"), isOn: $gatewaySandbox).toggleStyle(.checkbox)
                    Button(L("Publish")) { Task { await addGateway() } }
                        .disabled(gatewayID.isEmpty || gatewayTarget.isEmpty)
                }
                .textFieldStyle(.roundedBorder)
                .padding(12)
                if !gatewayError.isEmpty {
                    Text(gatewayError).font(.caption).foregroundStyle(Color.knodeBad).padding([.horizontal, .bottom], 12)
                }
            }
            .knodeCard(padding: 0)
        }
    }

    // MARK: - actions

    private static func when(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    private func load() async {
        do {
            let client = try model.client()
            let view = try await client.me()
            me = view
            model.account = view
            sessions = try await client.authSessions()
            if view.account.isAdmin, view.groups?["settings"] == true {
                users = try await client.adminUsers()
                gateways = try await client.gateways()
            }
        } catch {
            model.showError(error, prefix: L("Could not load access"))
        }
    }

    private func changePassword() async {
        guard newPassword == confirmation else {
            passwordFailed = true
            passwordMessage = L("The new passwords do not match.")
            return
        }
        do {
            let renewal = try await model.client().changePassword(current: current, new: newPassword)
            model.adopt(renewal)
            current = ""
            newPassword = ""
            confirmation = ""
            passwordFailed = false
            passwordMessage = L("Password changed — your other sessions have ended.")
            await load()
        } catch {
            passwordFailed = true
            passwordMessage = error.localizedDescription
        }
    }

    private func signOutOthers() async {
        do {
            model.adopt(try await model.client().signOutOthers())
            model.showToast(L("Signed out everywhere else"))
            await load()
        } catch {
            model.showError(error)
        }
    }

    private func endSession(_ id: String) async {
        do {
            _ = try await model.client().endSession(id: id)
            await load()
        } catch {
            model.showError(error)
        }
    }

    private func save(_ draft: AdminUserDraft, username: String?) async throws {
        if let username {
            _ = try await model.client().updateUser(username, draft)
            model.showToast(L("Saved %@", username))
        } else {
            let created = try await model.client().createUser(draft)
            model.showToast(L("Created %@", created.username))
        }
        await load()
    }

    private func signOutUser(_ username: String) async {
        do {
            _ = try await model.client().signOutUser(username)
            model.showToast(L("%@ was signed out everywhere", username))
            await load()
        } catch {
            model.showError(error)
        }
    }

    private func removeUser(_ username: String) async {
        do {
            _ = try await model.client().removeUser(username)
            model.showToast(L("Removed %@", username))
            await load()
        } catch {
            model.showError(error)
        }
    }

    private func addGateway() async {
        do {
            let gateway = try await model.client().addGateway(
                id: gatewayID.trimmingCharacters(in: .whitespaces).lowercased(),
                target: gatewayTarget.trimmingCharacters(in: .whitespaces),
                description: gatewayDescription.trimmingCharacters(in: .whitespaces),
                sandbox: gatewaySandbox
            )
            gatewayID = ""
            gatewayTarget = ""
            gatewayDescription = ""
            gatewaySandbox = true
            gatewayError = ""
            model.showToast(L("Published /gw/%@/", gateway.id))
            await load()
        } catch {
            gatewayError = error.localizedDescription
        }
    }

    private func removeGateway(_ id: String) async {
        do {
            _ = try await model.client().removeGateway(id: id)
            await load()
        } catch {
            model.showError(error)
        }
    }
}

/// Which user the editor sheet is open for (nil: a new one).
struct UserEditor: Identifiable {
    var user: AdminUser?
    var isSelf: Bool
    var id: String { user?.username ?? "+new" }
}

private struct UserEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    let editor: UserEditor
    let apiGroups: [String: String]
    let onSave: (AdminUserDraft, String?) async throws -> Void
    @State private var username = ""
    @State private var name = ""
    @State private var password = ""
    @State private var role = "member"
    @State private var teams = ""
    @State private var gateways = ""
    @State private var everything = false
    @State private var remote: Set<String> = []
    @State private var disabled = false
    @State private var error = ""
    @State private var saving = false

    private static let memberDefault: Set<String> = ["files", "search", "ask", "knowledge", "ingest", "traces"]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: L("Account"))
                Text(editor.user.map { L("Edit %@", $0.username) } ?? L("Add a user")).font(.title.bold())
                Text(editor.isSelf
                    ? L("Your own password, role and sign-in are changed under Account, or by another administrator.")
                    : L("They sign in with this username and password, here or from the other machines you allow."))
                    .foregroundStyle(.secondary)
            }
            Form {
                TextField(L("Username"), text: $username).disabled(editor.user != nil)
                TextField(L("Display name"), text: $name)
                if !editor.isSelf {
                    SecureField(editor.user == nil ? L("Password (at least 8 characters)") : L("New password (empty keeps the current one)"), text: $password)
                    Picker(L("Role"), selection: $role) {
                        Text(L("Member")).tag("member")
                        Text(L("Administrator")).tag("admin")
                    }
                }
                TextField(L("Teams (comma-separated, * for all)"), text: $teams)
                TextField(L("Gateways (comma-separated, * for all)"), text: $gateways)
                Section(L("From other machines")) {
                    Toggle(L("Everything the role allows"), isOn: $everything)
                    ForEach(AccessView.groupOrder.filter { apiGroups[$0] != nil }, id: \.self) { group in
                        Toggle(isOn: Binding(
                            get: { everything || remote.contains(group) },
                            set: { on in if on { remote.insert(group) } else { remote.remove(group) } }
                        )) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(group)
                                Text(apiGroups[group] ?? "").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .disabled(everything)
                    }
                }
                if editor.user != nil && !editor.isSelf {
                    Toggle(L("Disabled — refuse sign-in"), isOn: $disabled)
                }
            }
            .formStyle(.grouped)
            if !error.isEmpty { Text(error).foregroundStyle(Color.knodeBad) }
            HStack {
                Spacer()
                Button(L("Cancel")) { dismiss() }
                Button(L("Save")) { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(saving || username.isEmpty)
            }
        }
        .padding(26)
        .frame(width: 560, height: 680)
        .onAppear {
            guard let user = editor.user else {
                remote = Self.memberDefault
                return
            }
            username = user.username
            name = user.name
            role = user.role
            teams = user.teams.joined(separator: ", ")
            gateways = user.gateways.joined(separator: ", ")
            everything = user.remoteApis.contains("*")
            remote = Set(user.remoteApis)
            disabled = user.disabled ?? false
        }
    }

    private func list(_ value: String) -> [String] {
        value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var draft = AdminUserDraft(
            name: name.trimmingCharacters(in: .whitespaces),
            teams: list(teams),
            remoteApis: everything ? ["*"] : AccessView.groupOrder.filter { remote.contains($0) },
            gateways: list(gateways)
        )
        if !editor.isSelf {
            draft.role = role
            if editor.user != nil { draft.disabled = disabled }
            if !password.isEmpty || editor.user == nil {
                guard password.count >= 8 else {
                    error = L("Passwords need at least %@ characters.", "8")
                    return
                }
                draft.password = password
            }
        }
        if editor.user == nil { draft.username = username.trimmingCharacters(in: .whitespaces).lowercased() }
        do {
            try await onSave(draft, editor.user?.username)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Small labelled chips that wrap.
private struct FlowChips: View {
    let items: [(String, Bool)]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 6, alignment: .leading)], alignment: .leading, spacing: 6) {
            ForEach(items, id: \.0) { title, allowed in
                Label(title, systemImage: allowed ? "checkmark" : "xmark")
                    .font(.caption)
                    .foregroundStyle(allowed ? Color.knodeGood : Color.secondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .overlay { Capsule().stroke((allowed ? Color.knodeGood : Color.secondary).opacity(0.35)) }
            }
        }
    }
}
