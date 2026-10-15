import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var model: AppModel
    @State private var username = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var remember = true
    @State private var error = ""
    @State private var isWorking = false
    @State private var showingConnection = false

    private var connected: Bool {
        if case .connected = model.connectionState { return model.authInfo != nil }
        return false
    }
    private var checking: Bool { model.connectionState == .checking }

    /// The service has no accounts and this Mac may make the first one.
    private var setupHere: Bool { connected && model.authInfo?.setupRequired == true && model.authInfo?.canSetup == true }
    /// The service has no accounts, and they are made on its own machine.
    private var setupElsewhere: Bool { connected && model.authInfo?.setupRequired == true && model.authInfo?.canSetup != true }

    var body: some View {
        AuthShell {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: !connected ? L("Connection") : setupHere ? L("First run") : L("Welcome back"))
                    Text(!connected ? (checking ? L("Connecting…") : L("Connection unavailable")) : setupHere ? L("Create the administrator") : setupElsewhere ? L("This service has no accounts") : L("Sign in to knode-os"))
                        .font(.system(size: 30, weight: .bold))
                    Text(!connected ? L("Connect to your knode-os service to sign in. Check the destination and the service port if the connection fails.") : setupHere
                        ? L("The first account, made here on the machine knode-os runs on, administers it: settings, users and gateways.")
                        : setupElsewhere
                            ? L("The administrator is created on the machine knode-os runs on: run `knode-os user add <name> --admin` there, or open knode-os on it. Then sign in here.")
                            : L("Continue to your personal knowledge workspace and Teams."))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                connectionRow

                if let notice = model.authNotice, !setupHere {
                    Label(notice, systemImage: "info.circle.fill")
                        .font(.callout)
                        .foregroundStyle(Color.knodeCyan)
                }
                if let prompt = model.trustPrompt {
                    trustBox(prompt)
                }

                if !connected {
                    Button(L("Retry connection")) { Task { await model.checkConnection(startBundled: true) } }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                        .disabled(checking)
                } else if !setupElsewhere {
                    VStack(alignment: .leading, spacing: 14) {
                        LabeledContent(L("Username")) {
                            TextField(setupHere ? L("e.g. admin") : L("Your username"), text: $username)
                                .textFieldStyle(.roundedBorder)
                                .textContentType(.username)
                                .frame(width: 330)
                        }
                        LabeledContent(L("Password")) {
                            SecureField(setupHere ? L("At least 8 characters") : L("Enter your password"), text: $password)
                                .textFieldStyle(.roundedBorder)
                                .textContentType(setupHere ? .newPassword : .password)
                                .frame(width: 330)
                        }
                        if setupHere {
                            LabeledContent(L("Confirm")) {
                                SecureField(L("Enter it again"), text: $confirmation)
                                    .textFieldStyle(.roundedBorder)
                                    .textContentType(.newPassword)
                                    .frame(width: 330)
                            }
                        } else {
                            Toggle(L("Keep me signed in"), isOn: $remember)
                                .toggleStyle(.checkbox)
                        }
                        if !error.isEmpty {
                            Label(error, systemImage: "exclamationmark.circle.fill")
                                .font(.callout)
                                .foregroundStyle(Color.knodeBad)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    Button {
                        submit()
                    } label: {
                        HStack {
                            if isWorking { ProgressView().controlSize(.small) }
                            Text(setupHere ? L("Create administrator") : L("Sign in"))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(isWorking)

                    Text(setupHere ? L("Workspaces of an existing user stay theirs: name the administrator after the folder under users/ to keep yours.") : L("No account? An administrator of this service creates one for you."))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity)
                } else {
                    Button(L("Check again")) { Task { await model.checkConnection(startBundled: true) } }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                }
            }
            .frame(width: 420)
        }
        .onAppear {
            if username.isEmpty { username = model.currentUser?.username ?? "" }
        }
        .onChange(of: model.connection.identity) { _, _ in
            password = ""
            confirmation = ""
            error = ""
        }
        .sheet(isPresented: $showingConnection) {
            ConnectionSheet(isPresented: $showingConnection)
                .environmentObject(model)
        }
    }

    private var connectionRow: some View {
        HStack(spacing: 9) {
            switch model.connectionState {
            case .checking: ProgressView().controlSize(.small)
            case .connected: StatusDot(color: .knodeGood)
            case .unavailable: StatusDot(color: .knodeBad)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(model.serverURLString).font(.callout.monospaced()).lineLimit(1)
                if case .unavailable(let message) = model.connectionState {
                    Text(message).font(.caption).foregroundStyle(Color.knodeBad).lineLimit(3)
                        .textSelection(.enabled).help(message)
                } else {
                    Text(ConnectionSheet.modeTitle(model.connection.mode)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Button(L("Change…")) { showingConnection = true }
                .buttonStyle(.link)
        }
        .padding(10)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10))
    }

    private func trustBox(_ prompt: AppModel.TrustPrompt) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(L("Trust this certificate?"), systemImage: "lock.trianglebadge.exclamationmark")
                .font(.callout.weight(.semibold))
            Text(L("%@ presents a certificate this Mac does not trust. Compare its fingerprint with the one `knode-os tls init` printed on the server before you trust it.", prompt.hostPort))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(prompt.fingerprint)
                .font(.system(size: 10, design: .monospaced))
                .textSelection(.enabled)
            HStack {
                Spacer()
                Button(L("Trust and connect")) { model.trustPresentedCertificate() }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeViolet)
            }
        }
        .padding(12)
        .background(Color.knodeViolet.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
    }

    private func submit() {
        isWorking = true
        error = ""
        Task {
            if setupHere {
                error = await model.createAdministrator(username: username, password: password, confirmation: confirmation) ?? ""
            } else {
                error = await model.signIn(username: username, password: password, remember: remember) ?? ""
            }
            if error.isEmpty {
                password = ""
                confirmation = ""
            }
            isWorking = false
        }
    }
}

/// Where the service is: this Mac, a URL, or a machine reached over SSH.
struct ConnectionSheet: View {
    @EnvironmentObject private var model: AppModel
    @Binding var isPresented: Bool
    @State private var draft = ConnectionSettings()
    @State private var sshPortText = ""
    @State private var remotePortText = "9100"
    @State private var hosts = SSHConfig.Hosts()
    @State private var loadingHosts = false

    static func modeTitle(_ mode: ConnectionMode) -> String {
        switch mode {
        case .local: L("This Mac")
        case .remote: L("Domain or address (HTTPS)")
        case .ssh: L("SSH tunnel")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow(text: L("Connection"))
                Text(L("Where is knode-os?")).font(.title2.bold())
                Text(L("A session belongs to one service: connecting to another asks you to sign in there."))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Picker(L("Connection"), selection: $draft.mode) {
                ForEach(ConnectionMode.allCases) { mode in
                    Text(mode == .remote ? "HTTPS" : Self.modeTitle(mode)).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            // Give the sheet an explicit viewport. Grouped Form's intrinsic
            // width and height used to push the header and picker out of bounds.
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    connectionFields
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(18)
            }
            .background(.quaternary.opacity(0.3), in: RoundedRectangle(cornerRadius: 12))

            HStack {
                Spacer()
                Button(L("Cancel")) { isPresented = false }
                    .keyboardShortcut(.cancelAction)
                Button(L("Connect"), action: connect)
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.mode == .ssh && (draft.sshDestination.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || sshValidationError != nil))
            }
        }
        .padding(24)
        .frame(minWidth: 560, idealWidth: 620, maxWidth: 760, minHeight: 400, idealHeight: 560, maxHeight: 680)
        .task {
            draft = model.connection
            sshPortText = draft.sshPort.map(String.init) ?? ""
            remotePortText = String(draft.sshRemotePort)
            await reloadHosts()
        }
    }

    @ViewBuilder
    private var connectionFields: some View {
        switch draft.mode {
        case .local:
            field(L("Service URL"), text: $draft.localURL, prompt: "http://127.0.0.1:9100")
            explanation(L("At the default address, http://127.0.0.1:9100, the app starts the service bundled inside it when nothing answers. Any other address is a service run elsewhere, such as a LaunchAgent."))
        case .remote:
            field(L("Service URL"), text: $draft.remoteURL, prompt: "https://knode.example.com")
            explanation(L("A domain in front of the service (Cloudflare Tunnel), or the address of its HTTPS listener (server.tls), e.g. https://192.168.1.20:12443. A self-signed certificate is shown to you to trust on first connect."))
            ForEach(draft.pinnedCertificates.keys.sorted(), id: \.self) { key in
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("Trusted certificate for %@", key)).font(.caption)
                    Text(draft.pinnedCertificates[key] ?? "")
                        .font(.caption.monospaced()).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Button(L("Forget")) { draft.pinnedCertificates[key] = nil }
                }
            }
        case .ssh:
            HStack {
                Menu {
                    ForEach(hosts.names, id: \.self) { host in
                        Button(host) {
                            draft.sshDestination = host
                            // A selected alias inherits its own settings.
                            sshPortText = ""
                            draft.sshIdentityFile = ""
                        }
                    }
                } label: {
                    Text(L("Choose from SSH config…")).lineLimit(1)
                }
                .disabled(loadingHosts || hosts.names.isEmpty)
                Button {
                    Task { await reloadHosts() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L("Reload SSH config"))
                .accessibilityLabel(L("Reload SSH config"))
                .disabled(loadingHosts)
            }
            if !hosts.unreadableFiles.isEmpty {
                explanation(L("Some SSH configuration files could not be read. You can still enter a destination below."))
            } else if hosts.names.isEmpty && !loadingHosts {
                explanation(L("No named hosts found in ~/.ssh/config. Enter a destination below."))
            }
            field(L("SSH destination"), text: $draft.sshDestination, prompt: L("Host alias or user@host"))
            explanation(L("Hosts are read from ~/.ssh/config and its Include files. SSH automatically uses the host's user, port, identity files and jump host. Leave the overrides below empty to use that configuration."))
            HStack(alignment: .top, spacing: 16) {
                field(L("knode-os port on that machine"), text: $remotePortText, prompt: "9100")
                field(L("SSH port (optional override)"), text: $sshPortText, prompt: L("From SSH config, otherwise 22"))
            }
            field(L("Identity file (optional override)"), text: $draft.sshIdentityFile, prompt: L("From SSH config or ssh-agent"))
            if let error = sshValidationError {
                Text(error).font(.caption).foregroundStyle(Color.knodeBad)
                    .fixedSize(horizontal: false, vertical: true)
            }
            explanation(L("Use a key in ssh-agent or the Keychain. Connect once in Terminal to trust a new host; this app does not ask for SSH passwords."))
        }
    }

    private func field(_ title: String, text: Binding<String>, prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout.weight(.medium))
            TextField(title, text: text, prompt: Text(prompt))
                .labelsHidden()
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
    }

    private func explanation(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var sshValidationError: String? {
        let destination = draft.sshDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        if destination.hasPrefix("-") || destination.contains(where: { $0.isWhitespace || $0.isNewline }) {
            return L("Enter a Host alias or user@host without spaces.")
        }
        let port = sshPortText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !port.isEmpty && !(Int(port).map { (1...65_535).contains($0) } ?? false) {
            return L("The SSH port must be 1–65535")
        }
        if !(Int(remotePortText.trimmingCharacters(in: .whitespacesAndNewlines)).map { (1...65_535).contains($0) } ?? false) {
            return L("The service port must be 1–65535")
        }
        return nil
    }

    private func reloadHosts() async {
        loadingHosts = true
        hosts = await Task.detached(priority: .utility) { SSHConfig.hosts() }.value
        loadingHosts = false
    }

    private func connect() {
        guard draft.mode != .ssh || sshValidationError == nil else { return }
        var next = draft
        next.sshDestination = next.sshDestination.trimmingCharacters(in: .whitespacesAndNewlines)
        next.sshPort = Int(sshPortText.trimmingCharacters(in: .whitespacesAndNewlines))
        next.sshRemotePort = Int(remotePortText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 9100
        model.applyConnection(next)
        isPresented = false
    }
}

struct WorkspaceChoiceView: View {
    @EnvironmentObject private var model: AppModel
    @State private var teamCode = ""
    @State private var error = ""

    var body: some View {
        AuthShell {
            VStack(alignment: .leading, spacing: 24) {
                Button(L("Back to sign in")) { model.goBackToSignIn() }
                    .buttonStyle(.link)

                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: L("Choose a workspace"))
                    Text(L("Where do you want to start?"))
                        .font(.system(size: 30, weight: .bold))
                    Text(L("Personal knowledge stays private. Join a Team to work from shared context."))
                        .foregroundStyle(.secondary)
                }

                Button { model.startPersonalWorkspace() } label: {
                    HStack(spacing: 14) {
                        InitialsBadge(value: model.pendingUser?.name ?? "You", size: 42)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(L("Default workspace")).fontWeight(.semibold)
                            Text(L("Private files, traces, and agent memory"))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(L("Open workspace"))
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.knodeCyan)
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                    }
                    .padding(14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.12)) }

                HStack {
                    Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
                    Text(L("OR JOIN A TEAM")).font(.caption2.monospaced()).foregroundStyle(.tertiary)
                    Rectangle().fill(Color.white.opacity(0.1)).frame(height: 1)
                }

                VStack(alignment: .leading, spacing: 10) {
                    Text(L("Invite link or Team code")).font(.callout.weight(.semibold))
                    HStack {
                        TextField(L("e.g. KNODE-LABS"), text: $teamCode)
                            .textFieldStyle(.roundedBorder)
                        Button(L("Join Team")) {
                            error = model.startTeamWorkspace(code: teamCode) ?? ""
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeViolet)
                    }
                    if !error.isEmpty { Text(error).font(.callout).foregroundStyle(Color.knodeBad) }
                }
            }
            .frame(width: 440)
        }
    }
}

private struct AuthShell<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        ZStack {
            Color(red: 0.055, green: 0.063, blue: 0.08).ignoresSafeArea()
            HStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 10) {
                        KnodeLogo(size: 30)
                        Text("knode-os")
                            .font(.headline)
                            .foregroundStyle(Color.knodeCyan)
                    }
                    Spacer()
                    VStack(alignment: .leading, spacing: 16) {
                        Eyebrow(text: L("Your knowledge, in context"))
                        Text(L("Build a memory that works the way you do."))
                            .font(.system(size: 42, weight: .bold))
                            .tracking(-1.4)
                            .frame(maxWidth: 480, alignment: .leading)
                        Text(L("Keep private research in your personal space, then bring the right knowledge into a shared Team when collaboration starts."))
                            .font(.title3)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: 480, alignment: .leading)
                    }
                    Spacer()
                    HStack(alignment: .top, spacing: 28) {
                        Benefit(index: L("01"), title: L("Local by default"), detail: L("Your files remain the source of truth."))
                        Benefit(index: L("02"), title: L("Ready for teams"), detail: L("Move between private and shared context."))
                        Benefit(index: L("03"), title: L("Built for agents"), detail: L("Search, graph, and recall stay connected."))
                    }
                }
                .padding(42)
                .frame(width: 560)
                .background(Color(red: 0.065, green: 0.086, blue: 0.112))

                content
                    .padding(56)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.regularMaterial)
            }
            .frame(width: 1040, height: 650)
            .clipShape(RoundedRectangle(cornerRadius: 22))
            .overlay { RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.09)) }
            .shadow(color: .black.opacity(0.4), radius: 50, y: 24)
        }
    }
}

private struct Benefit: View {
    let index: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1)
            Text(index).font(.caption2.monospaced()).foregroundStyle(Color.knodeViolet)
            Text(title).font(.callout.weight(.semibold))
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
