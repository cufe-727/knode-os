import SwiftUI

struct RootView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        Group {
            switch model.phase {
            case .signIn:
                AuthView()
            case .chooseWorkspace:
                WorkspaceChoiceView()
            case .app:
                MainWorkspaceView()
            }
        }
        .animation(.easeInOut(duration: 0.2), value: String(describing: model.phase))
    }
}

private struct MainWorkspaceView: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        NavigationSplitView {
            AppSidebar()
                .navigationSplitViewColumnWidth(min: 210, ideal: 238, max: 280)
        } detail: {
            destination
                .id("\(model.activeWorkspace?.id ?? "none")-\(model.workspaceRevision)-\(model.selectedSection.rawValue)")
                .navigationTitle("")
                .toolbar { workspaceToolbar }
        }
        .navigationSplitViewStyle(.balanced)
        .tint(.knodeCyan)
        .overlay(alignment: .bottom) {
            if let message = model.toastMessage {
                Label(message, systemImage: "checkmark.circle.fill")
                    .font(.callout.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.thickMaterial, in: Capsule())
                    .overlay { Capsule().stroke(Color.white.opacity(0.1)) }
                    .shadow(radius: 12)
                    .padding(.bottom, 20)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .task {
            while !Task.isCancelled {
                await model.refreshStats()
                try? await Task.sleep(nanoseconds: 15_000_000_000)
            }
        }
    }

    @ViewBuilder
    private var destination: some View {
        switch model.selectedSection {
        case .files: FileBrowserView()
        case .search: SearchView()
        case .ask: AskView()
        case .graph: KnowledgeGraphView()
        case .traces: TracesView()
        case .dream: DreamView()
        case .settings: SettingsView()
        }
    }

    @ToolbarContentBuilder
    private var workspaceToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            WorkspaceMenu()
        }
        ToolbarItem(placement: .principal) {
            HStack(spacing: 10) {
                Text(model.selectedSection.title)
                    .font(.headline)
                if let activity = model.globalActivity {
                    ProgressView().controlSize(.small)
                    Text(activity).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if let stats = model.stats {
                HStack(spacing: 9) {
                    MetricPill(value: stats.documents, label: "docs")
                    MetricPill(value: stats.chunks, label: "chunks")
                    MetricPill(value: stats.entities, label: "entities")
                    MetricPill(value: stats.relations, label: "rels")
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(.thinMaterial, in: Capsule())
            }
        }
    }
}

private struct AppSidebar: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingConnection = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                KnodeLogo(size: 30)
                VStack(alignment: .leading, spacing: 1) {
                    Text("knode-os").font(.headline)
                    Text(model.activeWorkspace?.displayName ?? "Workspace")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)

            List(AppSection.allCases) { section in
                Button {
                    model.selectedSection = section
                } label: {
                    Label {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(section.title)
                            Text(section.subtitle)
                                .font(.system(size: 9))
                                .foregroundStyle(model.selectedSection == section ? .secondary : .tertiary)
                                .lineLimit(1)
                        }
                    } icon: {
                        Image(systemName: section.symbol)
                            .foregroundStyle(model.selectedSection == section ? Color.knodeCyan : Color.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, 3)
                .listRowBackground(
                    RoundedRectangle(cornerRadius: 7)
                        .fill(model.selectedSection == section ? Color.accentColor : Color.clear)
                )
            }
            .listStyle(.sidebar)

            Divider()
            Button {
                showingConnection.toggle()
            } label: {
                HStack(spacing: 9) {
                    switch model.connectionState {
                    case .checking:
                        ProgressView().controlSize(.small)
                    case .connected:
                        StatusDot(color: .knodeGood)
                    case .unavailable:
                        StatusDot(color: .knodeBad)
                    }
                    VStack(alignment: .leading, spacing: 1) {
                        Text(connectionTitle).font(.caption.weight(.semibold))
                        Text(model.serverURLString)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption2).foregroundStyle(.tertiary)
                }
                .padding(12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .popover(isPresented: $showingConnection, arrowEdge: .trailing) {
                ConnectionPanel()
                    .environmentObject(model)
            }
        }
    }

    private var connectionTitle: String {
        switch model.connectionState {
        case .checking: "Checking service"
        case .connected: "Service connected"
        case .unavailable: "Service unavailable"
        }
    }
}

private struct ConnectionPanel: View {
    @EnvironmentObject private var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Knode service").font(.headline)
                Text("The app starts its bundled local service automatically. Enter another URL only when connecting to an externally managed service.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            TextField("http://127.0.0.1:9100", text: $model.serverURLString)
                .textFieldStyle(.roundedBorder)
            HStack {
                switch model.connectionState {
                case .checking:
                    ProgressView().controlSize(.small)
                    Text("Checking…")
                case .connected(let root):
                    Label("Connected", systemImage: "checkmark.circle.fill").foregroundStyle(Color.knodeGood)
                    if let root { Text(root).lineLimit(1).help(root).foregroundStyle(.secondary) }
                case .unavailable(let message):
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(Color.knodeBad)
                        .lineLimit(2)
                }
                Spacer()
            }
            .font(.caption)
            HStack {
                Spacer()
                Button("Connect") { model.applyServerURL() }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
            }
        }
        .padding(18)
        .frame(width: 390)
    }
}

private struct WorkspaceMenu: View {
    @EnvironmentObject private var model: AppModel
    @State private var showingWorkspacePicker = false
    @State private var showingCreateWorkspace = false
    @State private var showingJoinTeam = false
    @State private var workspaceName = ""
    @State private var teamCode = ""
    @State private var createError = ""
    @State private var joinError = ""
    @State private var isCreating = false

    var body: some View {
        Button {
            showingWorkspacePicker.toggle()
        } label: {
            HStack(spacing: 9) {
                InitialsBadge(
                    value: model.activeWorkspace?.name ?? "Workspace",
                    team: model.activeWorkspace?.kind == .team,
                    size: 26
                )
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.activeWorkspace?.displayName ?? "Default")
                        .font(.callout.weight(.semibold))
                        .lineLimit(1)
                    Text("Workspace")
                        .font(.system(size: 9, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .frame(minWidth: 132, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .popover(isPresented: $showingWorkspacePicker, arrowEdge: .bottom) {
            workspacePicker
        }
        .sheet(isPresented: $showingCreateWorkspace) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Eyebrow(text: "New context")
                    Text("Create a workspace").font(.title.bold())
                    Text("Each workspace has its own complete directory tree, index, graph, and model settings.")
                        .foregroundStyle(.secondary)
                }
                TextField("e.g. Product research", text: $workspaceName)
                    .textFieldStyle(.roundedBorder)
                if !createError.isEmpty { Text(createError).foregroundStyle(Color.knodeBad) }
                HStack {
                    Spacer()
                    Button("Cancel") { showingCreateWorkspace = false }
                    Button("Create workspace") {
                        isCreating = true
                        Task {
                            do {
                                try await model.createWorkspace(named: workspaceName)
                                workspaceName = ""
                                createError = ""
                                showingCreateWorkspace = false
                            } catch {
                                createError = error.localizedDescription
                            }
                            isCreating = false
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .disabled(isCreating || workspaceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(26)
            .frame(width: 460)
        }
        .sheet(isPresented: $showingJoinTeam) {
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 5) {
                    Eyebrow(text: "Shared context", color: .knodeViolet)
                    Text("Join a Team").font(.title.bold())
                    Text("Enter an invite code to create or open an isolated Team workspace.")
                        .foregroundStyle(.secondary)
                }
                TextField("e.g. KNODE-LABS", text: $teamCode)
                    .textFieldStyle(.roundedBorder)
                if !joinError.isEmpty { Text(joinError).foregroundStyle(Color.knodeBad) }
                HStack {
                    Spacer()
                    Button("Cancel") { showingJoinTeam = false }
                    Button("Join Team") {
                        joinError = model.joinTeam(code: teamCode) ?? ""
                        if joinError.isEmpty { showingJoinTeam = false }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeViolet)
                    .keyboardShortcut(.defaultAction)
                }
            }
            .padding(26)
            .frame(width: 460)
        }
    }

    private var workspacePicker: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("WORKSPACES")
                .font(.system(size: 9, weight: .bold, design: .monospaced))
                .tracking(1.1)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)

            ForEach(model.session?.workspaces ?? []) { workspace in
                Button {
                    model.switchWorkspace(to: workspace)
                    showingWorkspacePicker = false
                } label: {
                    HStack(spacing: 9) {
                        Image(systemName: workspace.kind == .personal ? "square.grid.2x2" : "person.2")
                            .frame(width: 18)
                            .foregroundStyle(workspace.kind == .personal ? Color.knodeCyan : Color.knodeViolet)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(workspace.displayName)
                                .font(.callout.weight(.medium))
                            Text(workspace.detail)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if workspace.id == model.activeWorkspace?.id {
                            Image(systemName: "checkmark")
                                .foregroundStyle(Color.knodeCyan)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }

            Divider()
            Button {
                showingWorkspacePicker = false
                showingCreateWorkspace = true
            } label: {
                Label("Create workspace…", systemImage: "plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
            }
            .buttonStyle(.plain)

            Button {
                showingWorkspacePicker = false
                showingJoinTeam = true
            } label: {
                Label("Join another Team…", systemImage: "person.2.badge.plus")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
            }
            .buttonStyle(.plain)

            Divider()
            Button(role: .destructive) {
                showingWorkspacePicker = false
                model.signOut()
            } label: {
                Label("Sign out", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 5)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.knodeBad)
        }
        .padding(10)
        .frame(width: 270)
    }
}
