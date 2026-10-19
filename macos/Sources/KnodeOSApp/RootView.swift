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
            VStack(spacing: 0) {
                // outside the .id below: the strip is stateless and should not
                // flicker as the screen under it is rebuilt. Settings draws its
                // own, because Save sits at its right end; its four tabs share
                // one host, so a sub-tab click never rebuilds it.
                if model.selectedSection.tabs.count > 1, model.selectedSection != .settings {
                    SectionTabs(section: model.selectedSection)
                    Divider()
                }
                destination
                    .id("\(model.activeWorkspace?.id ?? "none")-\(model.workspaceRevision)-\(model.selectedTab.host)")
            }
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
        switch model.selectedTab {
        case .files: FileBrowserView()
        case .search: SearchView()
        case .traces: TracesView()
        case .ask: AskView()
        case .graph: KnowledgeGraphView()
        case .entities: EntitiesView()
        case .wiki: WikiView()
        case .dream: DreamView()
        case .providers, .pipeline, .research, .chat, .workspace: SettingsView()
        case .access: AccessView()
        }
    }

    private var sectionTitleItem: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            HStack(spacing: 7) {
                Image(systemName: model.selectedSection.symbol)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color.knodeCyan)
                Text(model.selectedSection.title)
                    .font(.system(size: 13, weight: .semibold))
                    .fixedSize()
                if model.selectedSection.tabs.count > 1 {
                    Text("›")
                        .font(.system(size: 13))
                        .foregroundStyle(.tertiary)
                    Text(model.selectedTab.title)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                if let activity = model.globalActivity {
                    Divider().frame(height: 11)
                    ProgressView()
                        .controlSize(.small)
                        .scaleEffect(0.75)
                        .frame(width: 12, height: 12)
                    Text(activity)
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .fixedSize()
                }
            }
            .animation(.easeInOut(duration: 0.18), value: model.globalActivity)
        }
    }

    @ToolbarContentBuilder
    private var workspaceToolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            WorkspaceMenu()
        }
        // A window title, not a control: macOS 26 gives every toolbar item a glass
        // background, and around a bare word it reads as a stray pill.
        if #available(macOS 26.0, *) {
            sectionTitleItem.sharedBackgroundVisibility(.hidden)
        } else {
            sectionTitleItem
        }
        ToolbarItemGroup(placement: .primaryAction) {
            if model.processing != nil {
                ProcessingButton()
            }
            if let stats = model.stats {
                HStack(spacing: 9) {
                    MetricPill(value: stats.documents, label: L("docs"))
                    MetricPill(value: stats.chunks, label: L("chunks"))
                    MetricPill(value: stats.entities, label: L("entities"))
                    MetricPill(value: stats.relations, label: L("rels"))
                }
                .padding(.horizontal, 9)
                .padding(.vertical, 6)
                .background(.thinMaterial, in: Capsule())
            }
        }
    }
}

/// The second navigation level: the tabs of the selected section, as a pill
/// strip over the screen. Rendered only when a section has more than one tab.
///
/// `accessory` is what the screen does as a whole — Settings' Save — at the
/// strip's right end. When the window is too narrow for both, it drops to a
/// second line rather than squeezing the tab titles.
struct SectionTabs<Accessory: View>: View {
    @EnvironmentObject private var model: AppModel
    let section: AppSection
    let accessory: Accessory

    init(section: AppSection, @ViewBuilder accessory: () -> Accessory) {
        self.section = section
        self.accessory = accessory()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                tabs
                Spacer(minLength: 16)
                accessory
            }
            VStack(alignment: .trailing, spacing: 8) {
                HStack(spacing: 8) {
                    tabs
                    Spacer(minLength: 0)
                }
                accessory
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.bar)
    }

    private var tabs: some View {
        HStack(spacing: 8) {
            ForEach(section.tabs) { tab in
                let selected = tab == model.selectedTab
                Button {
                    model.select(tab)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: tab.symbol)
                            .font(.system(size: 11, weight: .medium))
                        Text(tab.title)
                            .font(.callout.weight(selected ? .semibold : .regular))
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(
                        selected ? Color.knodeCyan.opacity(0.16) : Color.secondary.opacity(0.08),
                        in: RoundedRectangle(cornerRadius: 9)
                    )
                    .overlay {
                        RoundedRectangle(cornerRadius: 9)
                            .stroke(selected ? Color.knodeCyan.opacity(0.55) : Color.white.opacity(0.06))
                    }
                    .foregroundStyle(selected ? Color.knodeCyan : Color.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(tab.subtitle)
            }
        }
    }
}

extension SectionTabs where Accessory == EmptyView {
    init(section: AppSection) {
        self.init(section: section) { EmptyView() }
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
                    model.select(section: section)
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
    @State private var showingConnection = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Knode service")).font(.headline)
                Text(L("This Mac, a domain or address over HTTPS, or a machine reached through an SSH tunnel. Each asks you to sign in."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(ConnectionSheet.modeTitle(model.connection.mode)).font(.caption).foregroundStyle(.secondary)
                Text(model.serverURLString).font(.callout.monospaced()).textSelection(.enabled)
                if let account = model.account?.account {
                    Text(L("Signed in as %@ (%@)", account.username, account.isAdmin ? L("administrator") : L("member")))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            HStack {
                switch model.connectionState {
                case .checking:
                    ProgressView().controlSize(.small)
                    Text(L("Checking…"))
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
                Button(L("Reconnect")) { Task { await model.checkConnection(startBundled: true) } }
                Spacer()
                Button(L("Change connection…")) { showingConnection = true }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
            }
        }
        .padding(18)
        .frame(width: 390)
        .sheet(isPresented: $showingConnection) {
            ConnectionSheet(isPresented: $showingConnection)
                .environmentObject(model)
        }
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
                    Text(L("Workspace"))
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
                    Eyebrow(text: L("New context"))
                    Text(L("Create a workspace")).font(.title.bold())
                    Text(L("Each workspace has its own complete directory tree, index, graph, and model settings."))
                        .foregroundStyle(.secondary)
                }
                TextField(L("e.g. Product research"), text: $workspaceName)
                    .textFieldStyle(.roundedBorder)
                if !createError.isEmpty { Text(createError).foregroundStyle(Color.knodeBad) }
                HStack {
                    Spacer()
                    Button(L("Cancel")) { showingCreateWorkspace = false }
                    Button(L("Create workspace")) {
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
                    Eyebrow(text: L("Shared context"), color: .knodeViolet)
                    Text(L("Join a Team")).font(.title.bold())
                    Text(L("Enter an invite code to create or open an isolated Team workspace."))
                        .foregroundStyle(.secondary)
                }
                TextField(L("e.g. KNODE-LABS"), text: $teamCode)
                    .textFieldStyle(.roundedBorder)
                if !joinError.isEmpty { Text(joinError).foregroundStyle(Color.knodeBad) }
                HStack {
                    Spacer()
                    Button(L("Cancel")) { showingJoinTeam = false }
                    Button(L("Join Team")) {
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
            Text(L("WORKSPACES"))
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

            Button {
                showingWorkspacePicker = false
                model.select(.access)
            } label: {
                Label(L("Account & access…"), systemImage: "person.badge.key")
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

/// Extraction, reviews and summaries spend model calls, so they run only when
/// someone starts them: the service never does on its own, not even after a
/// restart. The toolbar shows which it is; the panel starts and stops it.
private struct ProcessingButton: View {
    @EnvironmentObject private var model: AppModel
    @State private var showing = false

    private var running: Bool { model.processing?.processing?.running == true }

    var body: some View {
        Button {
            showing.toggle()
        } label: {
            HStack(spacing: 6) {
                StatusDot(color: running ? .knodeGood : .secondary)
                Text(running ? L("Processing") : L("Processing stopped"))
                    .font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.thinMaterial, in: Capsule())
        }
        .buttonStyle(.plain)
        .help(running ? L("Extraction, reviews and summaries are running") : L("Extraction, reviews and summaries wait until you start them"))
        .popover(isPresented: $showing, arrowEdge: .bottom) {
            ProcessingPanel()
                .environmentObject(model)
        }
    }
}

private struct ProcessingPanel: View {
    @EnvironmentObject private var model: AppModel
    @State private var working = false

    private var status: LabelingStatusResponse? { model.processing }
    private var running: Bool { status?.processing?.running == true }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("Processing")).font(.headline)
                Text(L("Extraction of entities, relations and claims, then duplicate reviews and summary pages. They spend model calls, so they run only after someone starts them — never on their own, not even after a restart."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                StatusDot(color: running ? .knodeGood : .secondary)
                Text(stateLine).font(.callout.weight(.medium))
            }
            if let local = status?.local, !local.isEmpty {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("On this service")).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    ForEach(local) { backend in
                        Text("\(backend.label) × \(backend.slots)\(running && backend.busy > 0 ? " · " + L("%@ busy", String(backend.busy)) : "")\(backend.pauseReason.map { " · " + L("resting: %@", $0) } ?? "")")
                            .font(.caption.monospaced())
                    }
                }
            }
            if let scheduler = status?.scheduler {
                Text(L("%@ documents waiting · last hour: %@ calls, %@ documents written", String(scheduler.queued), String(scheduler.lastHour?.calls ?? 0), String(scheduler.lastHour?.documentsWritten ?? 0)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let remote = status?.remoteWorkers, remote > 0 {
                Text(L("%@ remote workers are taking work too — they are started on their own machines.", String(remote)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            HStack {
                if !model.maySaveSettings {
                    Text(L("An administrator starts and stops processing.")).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                if working { ProgressView().controlSize(.small) }
                Button(running ? L("Stop processing") : L("Start processing")) {
                    working = true
                    Task {
                        await model.setProcessing(!running)
                        working = false
                    }
                }
                .buttonStyle(.borderedProminent)
                .tint(running ? .knodeBad : .knodeCyan)
                .disabled(working || !model.maySaveSettings)
            }
        }
        .padding(16)
        .frame(width: 380)
        .task { await model.refreshStats() }
    }

    private var stateLine: String {
        guard let state = status?.processing else { return L("Unknown") }
        let when = state.since.flatMap(Self.time)
        if state.running {
            if let when, let by = state.by { return L("Running since %@, started by %@", when, by) }
            return L("Running")
        }
        if let when, let by = state.by { return L("Stopped at %@ by %@", when, by) }
        return L("Stopped since the service started")
    }

    private static func time(_ iso: String) -> String? {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return nil }
        return date.formatted(date: .omitted, time: .shortened)
    }
}
