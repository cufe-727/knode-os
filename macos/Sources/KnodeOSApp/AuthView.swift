import SwiftUI

/// Sign-in, first run and the workspace choice draw what the web UI's
/// `#auth-view` draws (web/style.css, "authentication"): the whole window, an
/// introduction beside the form, with the same type, surfaces and controls.
/// A change to one belongs in the other.
struct AuthView: View {
    @EnvironmentObject private var model: AppModel
    @State private var username = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var remember = true
    @State private var revealPassword = false
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
            VStack(alignment: .leading, spacing: 0) {
                head
                    .padding(.bottom, 30)

                if setupElsewhere {
                    // the head ends "On that machine, run:", so the command comes next
                    Text(verbatim: "knode-os user add <name> --admin")
                        .font(.system(size: 13, design: .monospaced))
                        .foregroundStyle(Color.knodeCyan)
                        .textSelection(.enabled)
                        .padding(.vertical, 12)
                        .padding(.horizontal, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(AuthPalette.field, in: RoundedRectangle(cornerRadius: 9))
                        .overlay { RoundedRectangle(cornerRadius: 9).stroke(AuthPalette.borderStrong) }
                    AuthFootnote(text: L("or open knode-os there, in a browser or the app, and create it on the first screen. Then sign in here."))
                        .padding(.vertical, 18)
                    Button(L("Check again")) { Task { await model.checkConnection(startBundled: true) } }
                        .buttonStyle(AuthPrimaryButtonStyle())
                    connectionDetails
                        .padding(.top, 24)
                } else {
                    connectionDetails
                    if !connected {
                        Button(L("Retry connection")) { Task { await model.checkConnection(startBundled: true) } }
                            .buttonStyle(AuthPrimaryButtonStyle())
                            .disabled(checking)
                    } else {
                        form
                    }
                }
            }
        }
        .onAppear {
            if username.isEmpty { username = model.currentUser?.username ?? "" }
        }
        .onChange(of: model.connection.identity) { _, _ in
            password = ""
            confirmation = ""
            revealPassword = false
            error = ""
        }
        .sheet(isPresented: $showingConnection) {
            ConnectionSheet(isPresented: $showingConnection)
                .environmentObject(model)
        }
    }

    private var head: some View {
        if !connected {
            return AuthHead(
                eyebrow: L("Connection"),
                title: checking ? L("Connecting…") : L("Connection unavailable"),
                detail: L("Connect to your knode-os service to sign in. Check the destination and the service port if the connection fails.")
            )
        }
        if setupHere {
            return AuthHead(
                eyebrow: L("First run"),
                title: L("Create the administrator"),
                detail: L("The first account, made here on the machine knode-os runs on, administers it: settings, users and gateways.")
            )
        }
        if setupElsewhere {
            return AuthHead(
                eyebrow: L("Not set up yet"),
                title: L("This service has no accounts"),
                detail: L("The administrator is created on the machine knode-os runs on, never from another one. On that machine, run:")
            )
        }
        return AuthHead(
            eyebrow: L("Welcome back"),
            title: L("Sign in to knode-os"),
            detail: L("Continue to your personal knowledge workspace and Teams.")
        )
    }

    /// The web's `#login-form` and `#setup-form`: labels over full-width fields.
    private var form: some View {
        VStack(alignment: .leading, spacing: 0) {
            AuthLabel(text: L("Username"))
                .padding(.bottom, 7)
            AuthField(placeholder: setupHere ? L("e.g. admin") : L("Your username"), text: $username, contentType: .username)

            HStack {
                AuthLabel(text: L("Password"))
                Spacer()
                if !setupHere {
                    Button(revealPassword ? L("Hide") : L("Show")) { revealPassword.toggle() }
                        .buttonStyle(AuthTextButtonStyle(size: 11))
                }
            }
            .padding(.top, 18)
            .padding(.bottom, 7)
            AuthField(
                placeholder: setupHere ? L("At least 8 characters") : L("Enter your password"),
                text: $password,
                secure: setupHere || !revealPassword,
                contentType: setupHere ? .newPassword : .password
            )

            if setupHere {
                AuthLabel(text: L("Confirm password"))
                    .padding(.top, 18)
                    .padding(.bottom, 7)
                AuthField(placeholder: L("Enter it again"), text: $confirmation, secure: true, contentType: .newPassword)
            } else {
                Toggle(L("Keep me signed in"), isOn: $remember)
                    .toggleStyle(.checkbox)
                    .tint(.knodeCyan)
                    .font(.system(size: 12))
                    .foregroundStyle(AuthPalette.muted)
                    .padding(.top, 14)
                    .padding(.bottom, 16)
            }

            AuthError(text: error)

            Button(action: submit) {
                HStack(spacing: 8) {
                    if isWorking { ProgressView().controlSize(.small) }
                    Text(setupHere ? L("Create administrator") : L("Sign in"))
                }
            }
            .buttonStyle(AuthPrimaryButtonStyle())
            .keyboardShortcut(.defaultAction)
            .disabled(isWorking)

            AuthFootnote(text: setupHere ? L("Workspaces of an existing user stay theirs: name the administrator after the folder under users/ to keep yours.") : L("No account? An administrator of this service creates one for you."))
                .padding(.top, 18)
        }
    }

    /// The connection, and what it has to say: a notice, a certificate to trust.
    private var connectionDetails: some View {
        VStack(alignment: .leading, spacing: 16) {
            connectionRow
            if let notice = model.authNotice, !setupHere {
                AuthNote(text: notice)
            }
            if let prompt = model.trustPrompt {
                trustBox(prompt)
            }
        }
        .padding(.bottom, 16)
    }

    /// Which service this window signs in to. The web UI has none: a page
    /// signs in to the server that served it.
    private var connectionRow: some View {
        HStack(spacing: 9) {
            switch model.connectionState {
            case .checking: ProgressView().controlSize(.small)
            case .connected: StatusDot(color: .knodeGood)
            case .unavailable: StatusDot(color: .knodeBad)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(model.serverURLString)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(AuthPalette.text)
                    .lineLimit(1)
                if case .unavailable(let message) = model.connectionState {
                    Text(message).font(.system(size: 11)).foregroundStyle(Color.knodeBad).lineLimit(3)
                        .textSelection(.enabled).help(message)
                } else {
                    Text(ConnectionSheet.modeTitle(model.connection.mode)).font(.system(size: 11)).foregroundStyle(AuthPalette.muted)
                }
            }
            Spacer(minLength: 8)
            Button(L("Change…")) { showingConnection = true }
                .buttonStyle(AuthTextButtonStyle(size: 12, tone: .accent))
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 10)
        .frame(minHeight: 45)
        .background(AuthPalette.field, in: RoundedRectangle(cornerRadius: 9))
        .overlay { RoundedRectangle(cornerRadius: 9).stroke(AuthPalette.borderStrong) }
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
        .background(Color.knodeViolet.opacity(0.08), in: RoundedRectangle(cornerRadius: 9))
        .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.knodeViolet.opacity(0.28)) }
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
                revealPassword = false
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

/// The web's `#auth-workspaces` step.
struct WorkspaceChoiceView: View {
    @EnvironmentObject private var model: AppModel
    @State private var teamCode = ""
    @State private var error = ""

    var body: some View {
        AuthShell {
            VStack(alignment: .leading, spacing: 0) {
                Button(L("Back to sign in")) { model.goBackToSignIn() }
                    .buttonStyle(AuthTextButtonStyle(size: 12))
                    .padding(.bottom, 26)

                AuthHead(
                    eyebrow: L("Choose a workspace"),
                    title: L("Where do you want to start?"),
                    detail: L("Personal knowledge stays private. Join a Team to work from shared context.")
                )
                .padding(.bottom, 30)

                Button { model.startPersonalWorkspace() } label: {
                    HStack(spacing: 13) {
                        InitialsBadge(value: model.pendingUser?.name ?? "You", size: 40)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(L("Default workspace"))
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(AuthPalette.text)
                            Text(L("Private files, traces, and agent memory"))
                                .font(.system(size: 11))
                                .foregroundStyle(AuthPalette.muted)
                        }
                        Spacer(minLength: 8)
                        Text(L("Open workspace"))
                            .font(.system(size: 11))
                            .foregroundStyle(Color.knodeCyan)
                    }
                }
                .buttonStyle(WorkspaceChoiceButtonStyle())

                HStack(spacing: 12) {
                    Rectangle().fill(AuthPalette.border).frame(height: 1)
                    Text(L("or join a Team"))
                        .font(.system(size: 11))
                        .foregroundStyle(AuthPalette.muted)
                        .fixedSize()
                    Rectangle().fill(AuthPalette.border).frame(height: 1)
                }
                .padding(.vertical, 22)

                VStack(alignment: .leading, spacing: 0) {
                    AuthLabel(text: L("Invite link or Team code"))
                        .padding(.bottom, 7)
                    HStack(spacing: 8) {
                        AuthField(placeholder: L("e.g. KNODE-LABS"), text: $teamCode)
                            .onSubmit(joinTeam)
                        Button(L("Join Team"), action: joinTeam)
                            .buttonStyle(AuthTeamButtonStyle())
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    AuthError(text: error)
                        .padding(.top, 5)
                    Text(L("You can also join or create another Team later."))
                        .font(.system(size: 12))
                        .foregroundStyle(AuthPalette.muted)
                        .padding(.top, 2)
                }
                .padding(16)
                .background(AuthPalette.field.opacity(0.48), in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(AuthPalette.border) }
            }
        }
    }

    private func joinTeam() {
        error = model.startTeamWorkspace(code: teamCode) ?? ""
    }
}

// MARK: - The shell

/// The web's `.auth-shell`: the whole window, the introduction (`.auth-intro`,
/// 1.08fr) beside the form column (`.auth-panel`, 0.92fr and at least 420 wide),
/// the form held to 420 in the middle of its column.
private struct AuthShell<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { proxy in
            let size = proxy.size
            HStack(spacing: 0) {
                AuthIntro(window: size)
                    .frame(width: max(0, min(size.width * 0.54, size.width - 421)))
                Rectangle()
                    .fill(AuthPalette.border)
                    .frame(width: 1)
                ScrollView {
                    content
                        .frame(maxWidth: 420, alignment: .leading)
                        .padding(.horizontal, clamped(size.width * 0.046, 40, 96))
                        .padding(.vertical, 48)
                        .frame(maxWidth: .infinity, minHeight: size.height)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .background(AuthPalette.panel)
        // edge to edge, under a title bar that keeps only its window buttons,
        // as the page fills a browser's viewport
        .ignoresSafeArea(.container, edges: .top)
        .modifier(HiddenWindowTitle())
        .toolbarBackground(.hidden, for: .windowToolbar)
    }
}

/// The window's name would sit over the brand; macOS 14 keeps it.
private struct HiddenWindowTitle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.toolbar(removing: .title)
        } else {
            content
        }
    }
}

/// The web's `.auth-intro`: the brand at the top, the pitch and the three
/// benefits at the bottom, a faint circle behind the corner.
private struct AuthIntro: View {
    let window: CGSize

    var body: some View {
        let headline = clamped(window.width * 0.043, 36, 60)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                KnodeLogo(size: 30)
                Text(verbatim: "knode-os")
                    .font(.system(size: 14, weight: .bold))
                    .tracking(0.56)
                    .foregroundStyle(Color.knodeCyan)
            }

            Spacer(minLength: 40)

            VStack(alignment: .leading, spacing: 0) {
                Eyebrow(text: L("Your knowledge, in context"), size: 11)
                Text(L("Build a memory that works the way you do."))
                    .font(.system(size: headline, weight: .bold))
                    .tracking(-0.045 * headline)
                    .foregroundStyle(AuthPalette.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 520, alignment: .leading)
                    .padding(.top, 12)
                    .padding(.bottom, 18)
                Text(L("Keep private research in your personal space, then bring the right knowledge into a shared Team when collaboration starts."))
                    .font(.system(size: 16))
                    .lineSpacing(7)
                    .foregroundStyle(AuthPalette.pitch)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 500, alignment: .leading)
            }
            .padding(.bottom, 52)

            HStack(alignment: .top, spacing: 14) {
                Benefit(index: L("01"), title: L("Local by default"), detail: L("Your files remain the source of truth."))
                Benefit(index: L("02"), title: L("Ready for teams"), detail: L("Move between private and shared context."))
                Benefit(index: L("03"), title: L("Built for agents"), detail: L("Search, graph, and recall stay connected."))
            }
            .frame(maxWidth: 760, alignment: .leading)

            Text(L("One knowledge layer for you and the agents you work with."))
                .font(.system(size: 11))
                .foregroundStyle(AuthPalette.quiet)
                .padding(.top, 28)
        }
        .padding(.vertical, clamped(window.height * 0.045, 36, 64))
        .padding(.horizontal, clamped(window.width * 0.046, 40, 96))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(alignment: .bottomTrailing) {
            let diameter = clamped(window.width * 0.30, 430, 620)
            Circle()
                .fill(Color.knodeCyan.opacity(0.06))
                .frame(width: diameter, height: diameter)
                .offset(x: 160, y: 180)
        }
        .background(AuthPalette.intro)
        .clipped()
    }
}

private struct Benefit: View {
    let index: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(index)
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Color.knodeViolet)
            Text(title)
                .font(.system(size: 13, weight: .bold))
                .foregroundStyle(AuthPalette.text)
                .padding(.top, 8)
            Text(detail)
                .font(.system(size: 12))
                .lineSpacing(2)
                .foregroundStyle(AuthPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 3)
        }
        .padding(.top, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .top) {
            Rectangle().fill(AuthPalette.borderStrong).frame(height: 1)
        }
    }
}

// MARK: - The form's parts

private struct AuthHead: View {
    let eyebrow: String
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow(text: eyebrow, size: 11)
            Text(title)
                .font(.system(size: 28, weight: .bold))
                .tracking(-0.56)
                .foregroundStyle(AuthPalette.heading)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, 8)
            Text(detail)
                .font(.system(size: 13))
                .foregroundStyle(AuthPalette.muted)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct AuthLabel: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(AuthPalette.text)
    }
}

/// The web's `.auth-form > input`: 45 tall on the darkest surface, a cyan ring
/// while focused.
private struct AuthField: View {
    let placeholder: String
    @Binding var text: String
    var secure = false
    var contentType: NSTextContentType?
    @FocusState private var focused: Bool

    var body: some View {
        Group {
            if secure {
                SecureField("", text: $text, prompt: Text(placeholder).foregroundColor(AuthPalette.placeholder))
            } else {
                TextField("", text: $text, prompt: Text(placeholder).foregroundColor(AuthPalette.placeholder))
            }
        }
        .textFieldStyle(.plain)
        .textContentType(contentType)
        .focused($focused)
        .focusEffectDisabled()
        .font(.system(size: 14))
        .foregroundStyle(AuthPalette.text)
        .padding(.horizontal, 13)
        .frame(maxWidth: .infinity, minHeight: 45)
        .contentShape(RoundedRectangle(cornerRadius: 9))
        .onTapGesture { focused = true }
        .background(AuthPalette.field, in: RoundedRectangle(cornerRadius: 9))
        .overlay {
            RoundedRectangle(cornerRadius: 9)
                .stroke(focused ? Color.knodeCyan : AuthPalette.borderStrong)
        }
        .overlay {
            RoundedRectangle(cornerRadius: 10.5)
                .stroke(Color.knodeCyan.opacity(focused ? 0.12 : 0), lineWidth: 3)
                .padding(-1.5)
        }
        .accessibilityLabel(placeholder)
    }
}

private struct AuthError: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(Color.knodeBad)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, minHeight: 20, alignment: .topLeading)
    }
}

/// The web's `.auth-note`.
private struct AuthNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 12))
            .foregroundStyle(AuthPalette.text)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.vertical, 9)
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.knodeCyan.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.knodeCyan.opacity(0.28)) }
    }
}

/// The web's `.auth-demo-note`.
private struct AuthFootnote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.system(size: 11))
            .foregroundStyle(AuthPalette.note)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity)
    }
}

/// The web's `.auth-primary`.
private struct AuthPrimaryButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration)
    }

    private struct Styled: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.isEnabled) private var isEnabled
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(AuthPalette.onAccent)
                .frame(maxWidth: .infinity, minHeight: 46)
                .background(Color.knodeCyan, in: RoundedRectangle(cornerRadius: 9))
                .brightness(configuration.isPressed ? -0.06 : hovering && isEnabled ? 0.04 : 0)
                .opacity(isEnabled ? 1 : 0.6)
                .contentShape(RoundedRectangle(cornerRadius: 9))
                .onHover { hovering = $0 }
        }
    }
}

/// The web's `.team-code-row button`.
private struct AuthTeamButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration)
    }

    private struct Styled: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(AuthPalette.teamText)
                .padding(.horizontal, 14)
                .frame(maxHeight: .infinity)
                .background(Color.knodeViolet.opacity(configuration.isPressed ? 0.26 : hovering ? 0.2 : 0.12), in: RoundedRectangle(cornerRadius: 8))
                .overlay { RoundedRectangle(cornerRadius: 8).stroke(Color.knodeViolet) }
                .contentShape(RoundedRectangle(cornerRadius: 8))
                .onHover { hovering = $0 }
        }
    }
}

/// The web's `.workspace-choice`.
private struct WorkspaceChoiceButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration)
    }

    private struct Styled: View {
        let configuration: ButtonStyleConfiguration
        @State private var hovering = false

        var body: some View {
            let lit = hovering || configuration.isPressed
            configuration.label
                .padding(15)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(lit ? Color.knodeCyan.opacity(0.12) : AuthPalette.field, in: RoundedRectangle(cornerRadius: 12))
                .overlay { RoundedRectangle(cornerRadius: 12).stroke(lit ? Color.knodeCyan : AuthPalette.borderStrong) }
                .contentShape(RoundedRectangle(cornerRadius: 12))
                .onHover { hovering = $0 }
        }
    }
}

/// A bare text button: muted, cyan on hover (Show, Back to sign in), or cyan
/// throughout (the web's `.text-button`).
private struct AuthTextButtonStyle: ButtonStyle {
    enum Tone { case muted, accent }
    var size: CGFloat
    var tone: Tone = .muted

    func makeBody(configuration: Configuration) -> some View {
        Styled(configuration: configuration, size: size, tone: tone)
    }

    private struct Styled: View {
        let configuration: ButtonStyleConfiguration
        let size: CGFloat
        let tone: Tone
        @State private var hovering = false

        var body: some View {
            configuration.label
                .font(.system(size: size))
                .foregroundStyle(tone == .accent || hovering ? Color.knodeCyan : AuthPalette.muted)
                .underline(tone == .accent && hovering)
                .opacity(configuration.isPressed ? 0.7 : 1)
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

/// The web UI's sign-in colours (web/style.css: `:root` and "authentication").
private enum AuthPalette {
    /// `--bg`: fields and cards.
    static let field = Color(authHex: 0x0F1115)
    /// `--bg2`: the form column.
    static let panel = Color(authHex: 0x161A21)
    static let intro = Color(authHex: 0x11161D)
    /// `--fg`
    static let text = Color(authHex: 0xD7DDE6)
    /// `--muted`
    static let muted = Color(authHex: 0x8B95A5)
    static let placeholder = Color(authHex: 0x6E7889)
    /// `--border`
    static let border = Color(authHex: 0x262D39)
    /// `--border-strong`
    static let borderStrong = Color(authHex: 0x354052)
    static let headline = Color(authHex: 0xEDF6FF)
    static let heading = Color(authHex: 0xF1F5FA)
    static let pitch = Color(authHex: 0x9DA9B8)
    static let quiet = Color(authHex: 0x647083)
    static let note = Color(authHex: 0x687486)
    static let onAccent = Color(authHex: 0x071016)
    static let teamText = Color(authHex: 0xD9C7FF)
}

private extension Color {
    init(authHex hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}

/// CSS `clamp(low, value, high)`.
private func clamped(_ value: CGFloat, _ low: CGFloat, _ high: CGFloat) -> CGFloat {
    min(max(value, low), high)
}
