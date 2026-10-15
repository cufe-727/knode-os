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

    /// The service has no accounts and this Mac may make the first one.
    private var setupHere: Bool { model.authInfo?.setupRequired == true && model.authInfo?.canSetup == true }
    /// The service has no accounts, and they are made on its own machine.
    private var setupElsewhere: Bool { model.authInfo?.setupRequired == true && model.authInfo?.canSetup != true }

    var body: some View {
        AuthShell {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: setupHere ? L("First run") : L("Welcome back"))
                    Text(setupHere ? L("Create the administrator") : setupElsewhere ? L("This service has no accounts") : L("Sign in to knode-os"))
                        .font(.system(size: 30, weight: .bold))
                    Text(setupHere
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

                if !setupElsewhere {
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

    static func modeTitle(_ mode: ConnectionMode) -> String {
        switch mode {
        case .local: L("This Mac")
        case .remote: L("Domain or address (HTTPS)")
        case .ssh: L("SSH tunnel")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: L("Connection"))
                Text(L("Where is knode-os?")).font(.title.bold())
                Text(L("A session belongs to one service: connecting to another asks you to sign in there."))
                    .foregroundStyle(.secondary)
            }
            Picker("", selection: $draft.mode) {
                ForEach(ConnectionMode.allCases) { mode in Text(Self.modeTitle(mode)).tag(mode) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()

            Form {
                switch draft.mode {
                case .local:
                    TextField(L("Service URL"), text: $draft.localURL, prompt: Text("http://127.0.0.1:9100"))
                    Text(L("At the default address, http://127.0.0.1:9100, the app starts the service bundled inside it when nothing answers. Any other address is a service run elsewhere, such as a LaunchAgent."))
                        .font(.caption).foregroundStyle(.secondary)
                case .remote:
                    TextField(L("Service URL"), text: $draft.remoteURL, prompt: Text("https://knode.example.com"))
                    Text(L("A domain in front of the service (Cloudflare Tunnel), or the address of its HTTPS listener (server.tls), e.g. https://192.168.1.20:12443. A self-signed certificate is shown to you to trust on first connect."))
                        .font(.caption).foregroundStyle(.secondary)
                    if !draft.pinnedCertificates.isEmpty {
                        ForEach(draft.pinnedCertificates.keys.sorted(), id: \.self) { key in
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(L("Trusted certificate for %@", key)).font(.caption)
                                    Text(draft.pinnedCertificates[key] ?? "").font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Button(L("Forget")) { draft.pinnedCertificates[key] = nil }
                            }
                        }
                    }
                case .ssh:
                    TextField(L("SSH destination"), text: $draft.sshDestination, prompt: Text("you@mac-mini.local"))
                    TextField(L("SSH port"), text: $sshPortText, prompt: Text("22"))
                    TextField(L("knode-os port on that machine"), text: $remotePortText, prompt: Text("9100"))
                    TextField(L("Identity file (optional)"), text: $draft.sshIdentityFile, prompt: Text("~/.ssh/id_ed25519"))
                    Text(L("The app runs ssh -L to that machine's loopback and keeps it open. It never asks for a password: use a key in ssh-agent or the Keychain, and connect once in Terminal so the host key is known. Host aliases from ~/.ssh/config work."))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .formStyle(.grouped)

            HStack {
                Spacer()
                Button(L("Cancel")) { isPresented = false }
                Button(L("Connect")) {
                    var next = draft
                    next.sshPort = Int(sshPortText.trimmingCharacters(in: .whitespaces))
                    next.sshRemotePort = Int(remotePortText.trimmingCharacters(in: .whitespaces)) ?? 9100
                    model.applyConnection(next)
                    isPresented = false
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(26)
        .frame(width: 560)
        .onAppear {
            draft = model.connection
            sshPortText = draft.sshPort.map(String.init) ?? ""
            remotePortText = String(draft.sshRemotePort)
        }
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
