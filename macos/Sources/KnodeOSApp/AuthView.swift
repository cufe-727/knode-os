import SwiftUI

struct AuthView: View {
    @EnvironmentObject private var model: AppModel
    @State private var username = "admin"
    @State private var password = ""
    @State private var remember = true
    @State private var error = ""
    @State private var showingRegistration = false

    var body: some View {
        AuthShell {
            VStack(alignment: .leading, spacing: 26) {
                VStack(alignment: .leading, spacing: 8) {
                    Eyebrow(text: L("Welcome back"))
                    Text(L("Sign in to knode-os"))
                        .font(.system(size: 30, weight: .bold))
                    Text(L("Continue to your personal knowledge workspace and Teams."))
                        .foregroundStyle(.secondary)
                }

                VStack(alignment: .leading, spacing: 14) {
                    LabeledContent("Username") {
                        TextField(L("admin or test"), text: $username)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 330)
                    }
                    LabeledContent("Password") {
                        SecureField(L("Enter your password"), text: $password)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 330)
                    }
                    Toggle(L("Keep me signed in"), isOn: $remember)
                        .toggleStyle(.checkbox)
                    if !error.isEmpty {
                        Label(error, systemImage: "exclamationmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(Color.knodeBad)
                    }
                }

                Button {
                    error = model.signIn(username: username, password: password, remember: remember) ?? ""
                } label: {
                    Text(L("Continue"))
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .tint(.knodeCyan)
                .keyboardShortcut(.defaultAction)

                VStack(spacing: 8) {
                    HStack(spacing: 4) {
                        Text(L("New here?")).foregroundStyle(.secondary)
                        Button(L("Create a local account")) { showingRegistration = true }
                            .buttonStyle(.link)
                    }
                    Text(L("Mock accounts: admin / admin or test / test"))
                        .font(.caption.monospaced())
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity)
            }
            .frame(width: 400)
        }
        .sheet(isPresented: $showingRegistration) {
            RegistrationView(isPresented: $showingRegistration)
                .environmentObject(model)
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

private struct RegistrationView: View {
    @EnvironmentObject private var model: AppModel
    @Binding var isPresented: Bool
    @State private var username = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var error = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                Eyebrow(text: L("Local account"))
                Text(L("Create an account")).font(.title.bold())
                Text(L("Credentials stay on this Mac. The server still listens only on localhost."))
                    .foregroundStyle(.secondary)
            }
            Form {
                TextField(L("Username"), text: $username)
                SecureField(L("Password"), text: $password)
                SecureField(L("Confirm password"), text: $confirmation)
            }
            .formStyle(.grouped)
            if !error.isEmpty { Text(error).foregroundStyle(Color.knodeBad) }
            HStack {
                Spacer()
                Button(L("Cancel")) { isPresented = false }
                Button(L("Create account")) {
                    error = model.register(username: username, password: password, confirmation: confirmation) ?? ""
                    if error.isEmpty { isPresented = false }
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(28)
        .frame(width: 480)
    }
}
