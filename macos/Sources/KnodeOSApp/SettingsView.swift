import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @State private var config: KnodeConfig?
    @State private var testResult: ConfigTestResponse?
    @State private var statusMessage = ""
    @State private var statusIsError = false
    @State private var isLoading = true
    @State private var isWorking = false
    @State private var showingClearConfirmation = false
    @State private var cliTools: [String: CliTool] = [:]
    /// Provider ids whose row is open. Survives a save, unlike a per-row @State.
    @State private var expandedProviders: Set<String> = []
    /// Which pipeline node the inspector below the flow is showing.
    @State private var selectedStage: PipelineStage = .convert
    /// Model lists, shared by every picker on the screen.
    @StateObject private var catalog = ModelCatalog()
    /// The named agents Ask and Research point at (the second table on 01).
    @State private var agents: [AgentDefinition] = []
    @State private var agentToRemove: AgentDefinition?
    @State private var profiles: [ResearchProfileSummary] = []
    @State private var profileDraft: ResearchProfileDetail?
    @State private var profileDirty = false
    /// A profile the user picked while the current one has unsaved edits.
    @State private var pendingProfile: String?
    @State private var showingDuplicate = false
    @State private var duplicateName = ""
    @State private var showingProfileDelete = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                hero
                if isLoading && config == nil {
                    ProgressView("Loading model routes…")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 80)
                } else if config != nil {
                    // one section per sub-tab; the hero above and the results
                    // below stay put, because `Test stages` tests every stage
                    switch model.selectedTab {
                    case .pipeline: pipelineSection
                    case .research: researchSection
                    case .workspace: workspaceDangerSection
                    default: providersSection
                    }
                    if let testResult { testResults(testResult) }
                    if !statusMessage.isEmpty {
                        Label(statusMessage, systemImage: statusIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(statusIsError ? Color.knodeBad : Color.knodeGood)
                            .knodeCard()
                    }
                } else {
                    EmptyState(symbol: "slider.horizontal.3", title: L("Could not load settings"), message: L("The local service is unavailable. Retry to start it and reload this workspace's routes."), actionTitle: L("Retry"), action: { Task { await retry() } })
                }
            }
            .padding(28)
            .frame(maxWidth: 1040)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .environmentObject(catalog)
        .task { await load() }
        .onChange(of: model.connectionState) { _, state in
            if case .connected = state, config == nil {
                Task { await load() }
            }
        }
        .confirmationDialog(
            L("Clear %@?", model.activeWorkspace?.displayName ?? L("this workspace")),
            isPresented: $showingClearConfirmation,
            titleVisibility: .visible
        ) {
            Button(L("Clear workspace"), role: .destructive) { Task { await clearWorkspace() } }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(L("This permanently deletes every file, index, graph, trace, suggestion, and model setting in the workspace. The empty workspace itself remains available."))
        }
        .confirmationDialog(
            L("Discard unsaved changes to %@?", profileDraft?.name ?? L("this profile")),
            isPresented: Binding(get: { pendingProfile != nil }, set: { if !$0 { pendingProfile = nil } }),
            titleVisibility: .visible
        ) {
            Button(L("Discard and switch"), role: .destructive) {
                guard let name = pendingProfile else { return }
                pendingProfile = nil
                config?.research.profile = name
                Task { await loadProfileDetail(name) }
            }
            Button(L("Keep editing"), role: .cancel) { pendingProfile = nil }
        }
        .confirmationDialog(
            profileDraft?.builtin == true
                ? L("Reset %@ to the built-in defaults?", profileDraft?.name ?? "")
                : L("Delete profile %@?", profileDraft?.name ?? ""),
            isPresented: $showingProfileDelete,
            titleVisibility: .visible
        ) {
            Button(profileDraft?.builtin == true ? L("Reset") : L("Delete"), role: .destructive) {
                Task { await deleteProfile() }
            }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(profileDraft?.builtin == true
                ? L("Its file goes back to the built-in profile, including every role prompt.")
                : L("The profile file and the roles defined in it are removed."))
        }
        .sheet(isPresented: $showingDuplicate) { duplicateSheet }
        .confirmationDialog(
            agentToRemove?.builtin == true
                ? L("Reset %@ to the built-in template?", agentToRemove?.title ?? "")
                : L("Remove agent %@?", agentToRemove?.title ?? ""),
            isPresented: Binding(get: { agentToRemove != nil }, set: { if !$0 { agentToRemove = nil } }),
            titleVisibility: .visible
        ) {
            Button(agentToRemove?.builtin == true ? L("Reset") : L("Remove"), role: .destructive) {
                guard let agent = agentToRemove else { return }
                agentToRemove = nil
                Task { await removeAgent(agent) }
            }
            Button(L("Cancel"), role: .cancel) { agentToRemove = nil }
        } message: {
            Text(agentToRemove?.builtin == true
                ? L("Its file goes back to the template, including the prompt.")
                : L("Anything pointing at it falls back to nothing configured."))
        }
    }

    private var hero: some View {
        HStack(alignment: .bottom, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Eyebrow(text: L("Model routing"))
                Text(L("Give each knowledge job the right model."))
                    .font(.system(size: 34, weight: .bold))
                    .tracking(-0.8)
                Text(L("Configure each provider once for %@, then point every pipeline stage at one of them. Test stages sends one real request per configured stage before you save.", model.activeWorkspace?.displayName ?? L("this workspace")))
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Picker(L("Language"), selection: $model.language) {
                ForEach(AppLanguage.allCases) { Text($0.label).tag($0) }
            }
            .labelsHidden()
            .frame(width: 148)
            .help(L("Interface language — prompts and pages keep the language they are written in"))
            Button(L("Test stages")) { Task { await test() } }
                .disabled(config == nil || isWorking)
            Button(L("Save & apply")) { Task { await save() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(config == nil || isWorking)
            if isWorking { ProgressView().controlSize(.small) }
        }
    }

    // MARK: - 01 · Providers

    /// Every endpoint and credential lives here, once, as one table: which
    /// embedding providers exist, which LLM providers exist, and which of each
    /// is the default. A row opens to its own form, so the page stays scannable
    /// however many are configured.
    private var providersSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                index: L("01 · Providers & agents"),
                title: L("Endpoints, credentials, and who does the work"),
                detail: L("Configure each provider once. Every stage below picks from this list, so no endpoint or key is ever entered twice — and every agent runs on one of them."),
                badge: L("Configure once"),
                color: .knodeCyan
            )
            VStack(spacing: 0) {
                providerTableHeader
                ForEach(Array((config?.embeddingProviders ?? []).enumerated()), id: \.element.id) { index, entry in
                    Divider()
                    embeddingRow(index: index, entry: entry)
                }
                ForEach(Array((config?.connections ?? []).enumerated()), id: \.element.id) { index, connection in
                    Divider()
                    connectionRow(index: index, connection: connection)
                }
            }
            .knodeCard(padding: 0)
            // an agent runs on one of the providers above, so it belongs under
            // them rather than behind a tab of its own
            agentsSection.padding(.top, 10)
        }
    }

    private var providerTableHeader: some View {
        HStack(spacing: 12) {
            Text(L("Kind"))
                .frame(width: 74, alignment: .leading)
            Text(L("Name"))
                .frame(width: 210, alignment: .leading)
            Text(L("Provider"))
                .frame(width: 170, alignment: .leading)
            Text(L("Model"))
            Spacer(minLength: 8)
            Menu {
                Button(L("LLM provider")) { addConnection() }
                Button(L("Embedding provider")) { addEmbeddingProvider() }
            } label: {
                Label(L("Add provider"), systemImage: "plus")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(config == nil)
        }
        .font(.system(size: 9, weight: .bold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(.tertiary)
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func embeddingRow(index: Int, entry: EmbeddingConnection) -> some View {
        ProviderRow(
            kind: L("Embed"),
            color: .knodeCyan,
            isDefault: entry.id == config?.embeddingUse,
            label: binding(\.embeddingProviders)[index].label,
            providerName: embeddingProviderName(entry.provider),
            summary: embeddingRowSummary(entry),
            id: entry.id,
            expanded: expandedBinding(entry.id),
            // Something has to embed, so the last one cannot be removed.
            remove: (config?.embeddingProviders.count ?? 0) > 1 ? { removeEmbeddingProvider(id: entry.id) } : nil
        ) {
            EmbeddingProviderFields(
                entry: binding(\.embeddingProviders)[index],
                route: "embedding:\(entry.id)",
                load: { refresh in try await modelList(route: "embedding:\(entry.id)", refresh: refresh) }
            )
        }
    }

    private func connectionRow(index: Int, connection: LLMConnection) -> some View {
        let isDefault = connection.id == config?.llmUse
        return ProviderRow(
            kind: L("LLM"),
            color: .knodeViolet,
            isDefault: isDefault,
            label: binding(\.connections)[index].label,
            providerName: providerName(connection.provider),
            summary: connection.model,
            id: connection.id,
            expanded: expandedBinding(connection.id),
            // something has to answer, so the last one cannot go
            remove: (config?.connections.count ?? 0) > 1 ? { removeConnection(id: connection.id) } : nil,
            makeDefault: isDefault ? nil : { config?.llmUse = connection.id }
        ) {
            LlmProviderFields(
                provider: binding(\.connections)[index].provider,
                model: binding(\.connections)[index].model,
                baseUrl: binding(\.connections)[index].baseUrl,
                apiKey: binding(\.connections)[index].apiKey,
                cliPath: binding(\.connections)[index].cliPath,
                effort: binding(\.connections)[index].effort,
                cliTools: cliTools,
                route: "connection:\(connection.id)",
                load: { refresh in try await modelList(route: "connection:\(connection.id)", refresh: refresh) }
            )
        }
    }

    private func expandedBinding(_ id: String) -> Binding<Bool> {
        Binding(
            get: { expandedProviders.contains(id) },
            set: { isOpen in
                if isOpen { expandedProviders.insert(id) } else { expandedProviders.remove(id) }
            }
        )
    }

    private func embeddingRowSummary(_ entry: EmbeddingConnection) -> String {
        let model = entry.provider == "local" ? L("Hashing") : entry.model
        return model.isEmpty ? L("%@d", String(entry.dimensions)) : "\(model) · \(entry.dimensions)d"
    }

    // MARK: - 02 · Pipeline

    /// The five stages as a flow, in the order a document passes through them.
    /// A node carries what a person checks at a glance — where it runs and how
    /// fast — and opens the inspector below for everything else, so the whole
    /// pipeline fits on one screen instead of two.
    private var pipelineSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                index: L("02 · Pipeline"),
                title: L("What each stage needs"),
                detail: L("A document moves down this list. The stages ask different things of a model, which is why each one can run somewhere else."),
                badge: L("Per stage"),
                color: .knodeViolet
            )
            VStack(alignment: .leading, spacing: 0) {
                stageFlow
                Divider()
                stageInspector
                Divider()
                budgetFooter
            }
            .knodeCard(padding: 0)
        }
    }

    private var stageFlow: some View {
        let stages = PipelineStage.allCases
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                ForEach(stages) { stage in
                    if stage != stages.first { stageArrow }
                    stageNode(stage)
                }
            }
            // A narrow window wraps rather than clipping the last stages.
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    ForEach(stages.prefix(3)) { stage in
                        if stage != stages.first { stageArrow }
                        stageNode(stage)
                    }
                }
                HStack(spacing: 8) {
                    ForEach(stages.suffix(2)) { stage in
                        if stage != stages.suffix(2).first { stageArrow }
                        stageNode(stage)
                    }
                }
            }
        }
        .padding(16)
    }

    private var stageArrow: some View {
        Image(systemName: "arrow.right")
            .font(.caption2)
            .foregroundStyle(.tertiary)
    }

    private func stageNode(_ stage: PipelineStage) -> some View {
        let selected = selectedStage == stage
        return Button {
            selectedStage = stage
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Text("\(stage.step)")
                        .font(.system(size: 9, weight: .bold, design: .monospaced))
                        .foregroundStyle(stage.color)
                        .frame(width: 16, height: 16)
                        .background(stage.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                    Text(stage.title).font(.system(size: 12, weight: .semibold))
                    Spacer(minLength: 0)
                }
                RouteBadge(label: stage.requirement, color: stage.color)
                Text(stageTarget(stage))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Text(stageRate(stage))
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
            .frame(width: 148, alignment: .leading)
            .padding(11)
            .background(selected ? stage.color.opacity(0.1) : Color.black.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(selected ? stage.color.opacity(0.55) : Color.white.opacity(0.07), lineWidth: selected ? 1.5 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// Where the selected stage runs, and the knobs that belong to it alone.
    @ViewBuilder
    private var stageInspector: some View {
        let stage = selectedStage
        HStack(alignment: .top, spacing: 20) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(stage.title).font(.headline)
                    RouteBadge(label: stage.requirement, color: stage.color)
                }
                Text(stage.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(stage.requirementDetail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                stageRates(stage)
            }
            Spacer(minLength: 16)
            stageControl(stage).frame(width: 300)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func stageControl(_ stage: PipelineStage) -> some View {
        switch stage {
        case .convert:
            StagePicker(
                route: binding(\.extraction.documentLlm),
                connections: config?.connections ?? [],
                defaultProvider: config?.llm.provider ?? "",
                defaultModel: config?.llm.model ?? "",
                routeKey: "documentLlm",
                load: { refresh in try await modelList(route: "documentLlm", refresh: refresh) }
            )
        case .index:
            VStack(alignment: .leading, spacing: 10) {
                FieldLabel(L("Run with")) {
                    Picker(L("Run with"), selection: binding(\.embeddingUse)) {
                        ForEach(config?.embeddingProviders ?? []) { entry in
                            Text(entry.label).tag(entry.id)
                        }
                    }
                    .labelsHidden()
                }
                Text(L("One provider at a time — vectors from two models are not comparable. Switching re-embeds the whole corpus when you save."))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .extract:
            StagePicker(
                route: binding(\.extraction.entityLlm),
                connections: config?.connections ?? [],
                defaultProvider: config?.llm.provider ?? "",
                defaultModel: config?.llm.model ?? "",
                routeKey: "entityLlm",
                load: { refresh in try await modelList(route: "entityLlm", refresh: refresh) }
            )
        case .synthesize:
            StagePicker(
                route: binding(\.extraction.conceptLlm),
                connections: config?.connections ?? [],
                defaultProvider: config?.llm.provider ?? "",
                defaultModel: config?.llm.model ?? "",
                routeKey: "conceptLlm",
                load: { refresh in try await modelList(route: "conceptLlm", refresh: refresh) }
            )
        case .answer:
            StagePin(value: defaultModelSummary, hint: L("Set in section 01 · Default LLM provider"))
        }
    }

    /// The rates that belong to this stage. They used to sit in one row below
    /// the whole pipeline, which read as global — "Parallel calls" only ever
    /// bounded Extract.
    @ViewBuilder
    private func stageRates(_ stage: PipelineStage) -> some View {
        switch stage {
        case .convert:
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                GridRow {
                    FieldLabel(L("Parallel conversions")) {
                        TextField(L("Parallel conversions"), value: binding(\.ingest.convertConcurrency), format: .number)
                    }
                    Color.clear.frame(height: 1)
                }
            }
            .padding(.top, 6)
        case .index:
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                GridRow {
                    FieldLabel(L("Parallel documents")) {
                        TextField(L("Parallel documents"), value: binding(\.ingest.concurrency), format: .number)
                    }
                    FieldLabel(L("Texts per request")) {
                        TextField(L("Texts per request"), value: embeddingBatchSize, format: .number)
                    }
                }
            }
            .padding(.top, 6)
        case .extract:
            VStack(alignment: .leading, spacing: 10) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                    GridRow {
                        FieldLabel(L("Parallel calls")) {
                            TextField(L("Parallel calls"), value: binding(\.extraction.concurrency), format: .number)
                        }
                        FieldLabel(L("Documents per pass")) {
                            TextField(L("Documents per pass"), value: binding(\.extraction.batchSize), format: .number)
                        }
                    }
                }
                Toggle(L("Extract factual claims alongside entities"), isOn: binding(\.extraction.claims))
                    .toggleStyle(.checkbox)
            }
            .padding(.top, 6)
        case .synthesize, .answer:
            EmptyView()
        }
    }

    /// The one control that is genuinely not a stage's own.
    private var budgetFooter: some View {
        HStack(alignment: .bottom, spacing: 16) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Daily token budget")).font(.subheadline.weight(.semibold))
                Text(L("Shared by Extract and Synthesize — the two stages that run in the background."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 12)
            TextField(L("Budget"), value: binding(\.extraction.dailyTokenBudget), format: .number)
                .textFieldStyle(.roundedBorder)
                .frame(width: 160)
        }
        .padding(18)
    }

    /// `batchSize` is optional in the mirror, but the field is a plain number.
    private var embeddingBatchSize: Binding<Int> {
        Binding(
            get: { config?.embedding.batchSize ?? 32 },
            set: { size in
                guard config != nil, let index = config!.embeddingProviders.firstIndex(where: { $0.id == config!.embeddingUse }) else { return }
                config!.embeddingProviders[index].batchSize = size
            }
        )
    }

    private func stageTarget(_ stage: PipelineStage) -> String {
        switch stage {
        case .convert: routeSummary(\.extraction.documentLlm)
        case .index: embeddingSummary
        case .extract: routeSummary(\.extraction.entityLlm)
        case .synthesize: routeSummary(\.extraction.conceptLlm)
        case .answer: defaultModelSummary
        }
    }

    private func stageRate(_ stage: PipelineStage) -> String {
        guard let config else { return "" }
        return switch stage {
        case .convert: "×\(config.ingest.convertConcurrency)"
        case .index: "×\(config.ingest.concurrency) · \(config.embedding.batchSize ?? 32)/req"
        case .extract: "×\(config.extraction.concurrency) · \(config.extraction.batchSize)/pass"
        case .synthesize, .answer: ""
        }
    }

    // MARK: - 03 · Deep research


    /// The second table on the Providers tab: who does the work, running on
    /// one of the providers above. Its own view since before the merge, so
    /// hosting it here is a call site and nothing else.
    @ViewBuilder
    private var agentsSection: some View {
        if config != nil {
            AgentsSettingsSection(
                agents: $agents,
                researchAgent: config?.research.agent ?? "",
                chatAgent: config?.chat.agent ?? "",
                connections: config?.connections ?? [],
                cliTools: cliTools,
                isWorking: isWorking,
                // an executor is a connection or a CLI, never an agent name
                inheritedModel: { inheritedModel($0) },
                add: { kind in Task { await addAgent(kind: kind) } },
                remove: { agentToRemove = $0 },
                loadModels: { executor, refresh in try await researchModelList(agent: executor, refresh: refresh) }
            )
        }
    }

    private func loadAgents() async {
        guard let response = try? await model.client().agents() else { return }
        agents = response.agents
    }

    /// A new agent is written immediately — it is its own file, not part of
    /// the config draft — and its name has to exist before Research can name it.
    private func addAgent(kind: String) async {
        isWorking = true
        defer { isWorking = false }
        let base = kind == "deep-research" ? "research" : "agent"
        var suffix = agents.count + 1
        while agents.contains(where: { $0.name == "\(base)-\(suffix)" }) { suffix += 1 }
        let name = "\(base)-\(suffix)"
        var draft = AgentDefinition(name: name, kind: kind)
        draft.title = kind == "deep-research" ? L("New research agent") : L("New agent")
        do {
            _ = try await model.client().saveAgent(name, draft.payload)
            await loadAgents()
            statusMessage = L("Agent %@ created", name)
            statusIsError = false
        } catch {
            statusMessage = L("Could not create the agent: %@", error.localizedDescription)
            statusIsError = true
        }
    }

    private func removeAgent(_ agent: AgentDefinition) async {
        isWorking = true
        defer { isWorking = false }
        do {
            let response = try await model.client().deleteAgent(agent.name)
            await loadAgents()
            // The service moves research/chat off a deleted agent, so read the
            // config back rather than leaving a name on screen that is gone.
            if response.reset != true, let fresh = try? await model.client().config() {
                config?.research.agent = fresh.research.agent
                config?.chat.agent = fresh.chat.agent
            }
            statusMessage = response.reset == true
                ? L("Agent %@ reset to the built-in", agent.name)
                : L("Agent %@ removed", agent.name)
            statusIsError = false
        } catch {
            statusMessage = L("Could not remove the agent: %@", error.localizedDescription)
            statusIsError = true
        }
    }

    /// Agents are files of their own, so "Save & apply" writes each edited one
    /// beside the config. A failure here must not read as a failed config save.
    private func saveAgents() async throws {
        for agent in agents {
            _ = try await model.client().saveAgent(agent.name, agent.payload)
        }
    }

    // MARK: - 03 · Research

    @ViewBuilder
    private var researchSection: some View {
        if config != nil {
            ResearchSettingsSection(
                research: binding(\.research),
                chat: binding(\.chat),
                profile: $profileDraft,
                dirty: $profileDirty,
                profileSelection: researchProfileBinding,
                summaries: profiles,
                connections: config?.connections ?? [],
                agents: agents,
                defaultProvider: config?.llm.provider ?? "",
                isWorking: isWorking,
                inheritedModel: { inheritedAgentSpecModel($0) },
                loadModels: { agent, refresh in try await researchModelList(agent: agent, refresh: refresh) },
                duplicate: {
                    duplicateName = "\(profileDraft?.name ?? "profile")-copy"
                    showingDuplicate = true
                },
                remove: { showingProfileDelete = true }
            )
        }
    }

    private var duplicateSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L("Duplicate profile")).font(.headline)
            Text(L("The copy starts from what is on screen, including unsaved edits. Select it above and save to make it the active profile."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("new-profile", text: $duplicateName)
                .textFieldStyle(.roundedBorder)
            Text(L("Letters, digits, - and _, up to 41 characters."))
                .font(.caption2)
                .foregroundStyle(.tertiary)
            HStack {
                Spacer()
                Button(L("Cancel")) { showingDuplicate = false }
                Button(L("Create")) {
                    showingDuplicate = false
                    Task { await duplicateProfile(as: duplicateName) }
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(!isValidProfileName(duplicateName))
            }
        }
        .padding(22)
        .frame(width: 420)
    }

    /// Picking another profile loads its file. Unsaved edits are not thrown
    /// away silently — the picker stays put until the dialog says otherwise.
    private var researchProfileBinding: Binding<String> {
        Binding(
            get: { config?.research.profile ?? "" },
            set: { name in
                guard !name.isEmpty, name != config?.research.profile else { return }
                if profileDirty {
                    pendingProfile = name
                    return
                }
                config?.research.profile = name
                Task { await loadProfileDetail(name) }
            }
        )
    }

    private func isValidProfileName(_ name: String) -> Bool {
        name.range(of: "^[a-z0-9][a-z0-9_-]{0,40}$", options: [.regularExpression, .caseInsensitive]) != nil
    }

    private func loadProfiles(preferred: String? = nil) async {
        guard config != nil else { return }
        do {
            let response = try await model.client().researchProfiles()
            profiles = response.profiles
            let names = Set(profiles.map(\.name))
            var name = preferred ?? config?.research.profile ?? response.active
            if !names.contains(name) { name = response.active }
            config?.research.profile = name
            await loadProfileDetail(name)
        } catch {
            profiles = []
            profileDraft = nil
        }
    }

    private func loadProfileDetail(_ name: String) async {
        do {
            profileDraft = try await model.client().researchProfile(name)
            profileDirty = false
        } catch {
            profileDraft = nil
            statusMessage = L("Research profile %@ could not be loaded: %@", name, error.localizedDescription)
            statusIsError = true
        }
    }

    /// Writes the profile YAML and the role prompts that differ from the
    /// built-ins. Returns what it saved, or nil when there is nothing to save.
    private func saveProfileDraft() async throws -> ResearchProfileDetail? {
        guard let draft = profileDraft else { return nil }
        let saved = try await model.client().saveResearchProfile(draft.payload(), prompts: draft.prompts)
        profileDraft = saved
        profileDirty = false
        return saved
    }

    private func duplicateProfile(as name: String) async {
        guard let draft = profileDraft, isValidProfileName(name) else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await model.client().saveResearchProfile(draft.payload(name: name), prompts: draft.prompts)
            await loadProfiles(preferred: name)
            statusMessage = L("Profile %@ created — save to make it the active profile", name)
            statusIsError = false
        } catch {
            statusMessage = L("Duplicate failed: %@", error.localizedDescription)
            statusIsError = true
        }
    }

    private func deleteProfile() async {
        guard let draft = profileDraft else { return }
        isWorking = true
        defer { isWorking = false }
        do {
            let response = try await model.client().deleteResearchProfile(draft.name)
            // A built-in comes back as its defaults, so stay on it; a deleted
            // one is gone and the list decides where to land.
            await loadProfiles(preferred: response.reset == true ? draft.name : nil)
            statusMessage = response.reset == true
                ? L("Profile %@ reset to the built-in", draft.name)
                : L("Profile %@ deleted", draft.name)
            statusIsError = false
        } catch {
            statusMessage = draft.builtin
                ? L("Reset failed: %@", error.localizedDescription)
                : L("Delete failed: %@", error.localizedDescription)
            statusIsError = true
        }
    }

    private var workspaceDangerSection: some View {
        HStack(spacing: 24) {
            VStack(alignment: .leading, spacing: 5) {
                Eyebrow(text: L("Danger zone"), color: .knodeBad)
                Text(L("Clear %@", model.activeWorkspace?.displayName ?? L("this workspace")))
                    .font(.headline)
                Text(L("Remove all workspace content and derived data, then leave behind a fresh empty directory tree."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button(L("Clear workspace"), role: .destructive) { showingClearConfirmation = true }
                .buttonStyle(.bordered)
                .tint(.knodeBad)
                .disabled(isWorking)
        }
        .padding(18)
        .background(Color.knodeBad.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.knodeBad.opacity(0.3)) }
    }

    private func testResults(_ result: ConfigTestResponse) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(L("Stage test results")).font(.headline)
            TestResultRow(label: L("1 · Convert"), result: result.documentLlm)
            TestResultRow(label: L("2 · Index"), result: result.embedding)
            TestResultRow(label: L("3 · Extract"), result: result.entityLlm)
            TestResultRow(label: L("4 · Synthesize"), result: result.conceptLlm)
            TestResultRow(label: L("5 · Answer"), result: result.llm)
        }
        .knodeCard()
    }

    private func sectionHeader(index: String, title: String, detail: String, badge: String, color: Color) -> some View {
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 3) {
                Eyebrow(text: index, color: color)
                Text(title).font(.title3.bold())
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            RouteBadge(label: badge, color: color)
        }
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<KnodeConfig, Value>) -> Binding<Value> {
        Binding(
            get: { config![keyPath: keyPath] },
            set: { config![keyPath: keyPath] = $0 }
        )
    }

    private var embeddingSummary: String {
        guard let config else { return L("Loading…") }
        guard let active = config.activeEmbedding else {
            return config.embedding.model.isEmpty ? L("API model not set") : config.embedding.model
        }
        if active.provider == "local" { return L("%@ · %@d", active.label, String(active.dimensions)) }
        return active.model.isEmpty ? L("API model not set") : "\(active.label) · \(active.model)"
    }

    private func routeSummary(_ keyPath: KeyPath<KnodeConfig, RoutedLLMConfig>) -> String {
        guard let config, let route = config[keyPath: keyPath] as RoutedLLMConfig? else { return L("Loading…") }
        let connection = config.connections.first { $0.id == route.use }
        let defaultName = config.llm.label?.isEmpty == false ? config.llm.label! : L("Default model")
        let name = connection?.label ?? (route.use.isEmpty ? defaultName : providerName(route.provider))
        // an inheriting route prints what it inherits, not a blank
        let model = route.model.isEmpty ? inheritedModel(route.use) : route.model
        return model.isEmpty ? name : "\(name) · \(model)"
    }

    /// What a route or agent spec inherits, against the on-screen draft.
    private func inheritedModel(_ use: String) -> String {
        inheritedRouteModel(use, connections: config?.connections ?? [], defaultModel: config?.llm.model ?? "")
    }

    private func inheritedAgentSpecModel(_ spec: String) -> String {
        inheritedAgentModel(spec, agents: agents, connections: config?.connections ?? [], defaultModel: config?.llm.model ?? "")
    }

    private var defaultModelSummary: String {
        guard let config else { return L("Not configured") }
        return config.llm.model.isEmpty ? providerName(config.llm.provider) : "\(providerName(config.llm.provider)) · \(config.llm.model)"
    }

    /// Models the service reports for one route, using the on-screen draft so a
    /// key or endpoint typed but not yet saved is the one that gets queried.
    private func modelList(route: String, refresh: Bool = false) async throws -> ModelListResponse {
        guard let config else { throw APIError(message: L("Settings are still loading")) }
        return try await model.client().listModels(route: route, config: config, refresh: refresh)
    }

    /// Models for a research agent. A named connection lists on its own route;
    /// a CLI picked straight off PATH has no connection, so ask the default
    /// route with that provider swapped into a copy of the draft.
    private func researchModelList(agent spec: String, refresh: Bool = false) async throws -> ModelListResponse {
        guard let config else { throw APIError(message: L("Settings are still loading")) }
        // A named agent is not an endpoint; what its executor points at is.
        let agent = agents.first { $0.name == spec }?.executor ?? spec
        if !agent.isEmpty, config.connections.contains(where: { $0.id == agent }) {
            return try await model.client().listModels(route: "connection:\(agent)", config: config, refresh: refresh)
        }
        var draft = config
        if !agent.isEmpty {
            draft.llm.provider = agent
            draft.llm.cliPath = ""
            draft.llm.model = ""
        }
        return try await model.client().listModels(route: "llm", config: draft, refresh: refresh)
    }

    /// The service writes 'default' for a migrated route; the picker uses '' for
    /// the same thing, so settle on one spelling as the config comes in.
    private func normalized(_ incoming: KnodeConfig) -> KnodeConfig {
        var config = incoming
        for keyPath in [\KnodeConfig.extraction.entityLlm, \KnodeConfig.extraction.conceptLlm, \KnodeConfig.extraction.documentLlm] {
            if config[keyPath: keyPath].use == "default" { config[keyPath: keyPath].use = "" }
        }
        return config
    }

    private func addConnection() {
        guard config != nil else { return }
        var suffix = config!.connections.count + 1
        while config!.connections.contains(where: { $0.id == "connection-\(suffix)" }) { suffix += 1 }
        let connection = LLMConnection(id: "connection-\(suffix)", label: "Connection \(suffix)")
        config!.connections.append(connection)
        expandedProviders.insert(connection.id)
    }

    private func addEmbeddingProvider() {
        guard config != nil else { return }
        var suffix = config!.embeddingProviders.count + 1
        while config!.embeddingProviders.contains(where: { $0.id == "embedding-\(suffix)" }) { suffix += 1 }
        let entry = EmbeddingConnection(id: "embedding-\(suffix)", label: "Embedding \(suffix)")
        config!.embeddingProviders.append(entry)
        expandedProviders.insert(entry.id)
    }

    /// Removing the active provider moves Index to the first one left, which
    /// re-embeds on save — so say it in the status line rather than let the
    /// corpus change underneath a person who only meant to tidy the list.
    private func removeEmbeddingProvider(id: String) {
        guard config != nil, config!.embeddingProviders.count > 1 else { return }
        config!.embeddingProviders.removeAll { $0.id == id }
        expandedProviders.remove(id)
        guard config!.embeddingUse == id, let next = config!.embeddingProviders.first else { return }
        config!.embeddingUse = next.id
        statusMessage = L("Index now runs on %@ — saving re-embeds the corpus.", next.label)
        statusIsError = false
    }

    /// Removing the default moves it to the first row left — the same shape as
    /// removing the active embedding provider, and said out loud for the same
    /// reason: every inheriting job moves with it.
    private func removeConnection(id: String) {
        guard config != nil, config!.connections.count > 1 else { return }
        config!.connections.removeAll { $0.id == id }
        expandedProviders.remove(id)
        if config!.llmUse == id, let next = config!.connections.first {
            config!.llmUse = next.id
            statusMessage = L("The default provider is now %@ — every job that names no provider of its own follows it.", next.label)
            statusIsError = false
        }
        // A route left pointing at a deleted connection would silently fall back
        // to the default; say so by moving it there explicitly.
        for keyPath in [\KnodeConfig.extraction.entityLlm, \KnodeConfig.extraction.conceptLlm, \KnodeConfig.extraction.documentLlm] {
            if config![keyPath: keyPath].use == id { config![keyPath: keyPath].use = "" }
        }
    }

    private func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            config = normalized(try await model.client().config())
            if let tools = try? await model.client().cliTools() {
                cliTools = Dictionary(tools.tools.map { ($0.provider, $0) }, uniquingKeysWith: { first, _ in first })
            }
            // With no agent configured, pre-fill what the service says can run
            // here. Only a pre-fill — nothing is saved until Save is pressed, so
            // "not configured" never quietly becomes a setting nobody chose.
            if config?.research.agent.isEmpty == true,
               let suggested = (try? await model.client().availableAgents())?.suggested {
                config?.research.agent = suggested
            }
            await loadAgents()
            await loadProfiles()
            statusMessage = ""
            testResult = nil
        } catch {
            config = nil
            model.showError(error, prefix: "Settings failed")
        }
    }

    private func retry() async {
        await model.checkConnection()
        await load()
    }

    private func test() async {
        guard let config else { return }
        isWorking = true
        statusMessage = L("Testing each configured stage…")
        statusIsError = false
        defer { isWorking = false }
        do {
            testResult = try await model.client().testConfig(config)
            statusMessage = L("Stage tests complete")
        } catch {
            statusMessage = L("Test failed: %@", error.localizedDescription)
            statusIsError = true
        }
    }

    private func save() async {
        guard let config else { return }
        isWorking = true
        model.globalActivity = "Applying model routes…"
        statusMessage = L("Saving routes… re-embedding if retrieval changed.")
        statusIsError = false
        defer {
            isWorking = false
            model.globalActivity = nil
        }
        // Agents are files of their own and the config may name one, so they
        // go first: `PUT /api/config` rejects an unknown chat/research agent,
        // which made "create an agent and point at it" fail in one Save.
        var agentNote = ""
        do {
            try await saveAgents()
        } catch {
            agentNote = L(" · agents not saved: %@", error.localizedDescription)
            statusIsError = true
        }
        do {
            let response = try await model.client().saveConfig(config)
            self.config = normalized(response.config)
            if response.reembedded, let reindex = response.reindex {
                statusMessage = L("Configuration saved · re-embedded %@ docs and %@ chunks", String(reindex.indexed), String(reindex.chunks))
            } else if response.reconverted == true, let reindex = response.reindex {
                statusMessage = L("Configuration saved · refreshed document conversion for %@ docs", String(reindex.indexed))
            } else {
                statusMessage = L("Configuration saved and stages applied")
            }
            // The research profile is a file of its own; a failure there must
            // not read as though the routes failed to save.
            do {
                if let saved = try await saveProfileDraft() {
                    statusMessage += L(" · research profile %@ saved", saved.name)
                }
            } catch {
                statusMessage += L(" · research profile not saved: %@", error.localizedDescription)
                statusIsError = true
            }
            statusMessage += agentNote
            model.showToast(L("Configuration saved for %@", model.activeWorkspace?.displayName ?? L("this workspace")))
            await model.refreshStats()
        } catch {
            statusMessage = L("Save failed: %@", error.localizedDescription)
            statusIsError = true
        }
    }

    private func clearWorkspace() async {
        isWorking = true
        statusMessage = L("Clearing workspace…")
        statusIsError = false
        defer { isWorking = false }
        do {
            try await model.clearActiveWorkspace()
            config = normalized(try await model.client().config())
            await loadProfiles()
            testResult = nil
            statusMessage = L("Workspace cleared. A fresh empty directory tree is ready.")
        } catch {
            statusMessage = L("Clear failed: %@", error.localizedDescription)
            statusIsError = true
        }
    }
}

/// A model name stays free text — any id the provider accepts — with a list of
/// what the configured provider actually offers: its own `/models`, the CLI's
/// own list, or the aliases a CLI documents when it has no list at all.
/// A model id stays free text, with a list of what the provider offers.
struct ModelField: View {
    let placeholder: String
    @Binding var text: String
    /**
     * The model that runs when this field is empty, shown greyed in its place.
     *
     * Never written. An empty `model` means "follow the provider", and pinning
     * the inherited string would stop the route tracking a later change to the
     * provider's own model — the propagation named connections exist for. The
     * popover's Clear link is how you get back to inheriting.
     */
    var inherited: String = ""
    /// Changing provider invalidates a fetched list, since it came from the old one.
    var providerKey: String = ""
    var disabled = false
    /// Which entry of the shared catalog this field reads. Two fields pointed
    /// at the same route share one list instead of each asking.
    let route: String
    let load: (Bool) async throws -> ModelListResponse

    @EnvironmentObject private var catalog: ModelCatalog
    @State private var isShowing = false
    @State private var filter = ""

    private var key: String { "\(route)|\(providerKey)" }
    private var result: ModelListResponse? { catalog.list(key) }
    private var failure: String? { catalog.failure(key) }
    private var isLoading: Bool { catalog.isLoading(key) }

    var body: some View {
        FieldLabel(L("Model")) {
            HStack(spacing: 6) {
                TextField(inherited.isEmpty ? placeholder : inherited, text: $text)
                Button {
                    isShowing = true
                    Task { await reload() }
                } label: {
                    Image(systemName: "chevron.down").font(.caption.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .help(L("List the models this provider offers"))
                .popover(isPresented: $isShowing, arrowEdge: .bottom) { picker }
            }
            .disabled(disabled)
            .onChange(of: providerKey) { _, _ in filter = "" }
        }
    }

    private var picker: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text(L("Models")).font(.headline)
                if let source = result?.source { RouteBadge(label: sourceLabel(source), color: source == "builtin" ? .knodeViolet : .knodeCyan) }
                Spacer()
                if isLoading { ProgressView().controlSize(.small) }
                Button { Task { await reload(force: true) } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .disabled(isLoading)
                    .help(L("Ask the provider again"))
            }
            if !options.isEmpty {
                TextField("Filter \(options.count) models", text: $filter)
                    .textFieldStyle(.roundedBorder)
                // An explicit height: a ScrollView has no ideal height of its
                // own, and a popover sizes itself to its content, so a
                // maxHeight alone collapses the list to nothing.
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        ForEach(filtered) { option in row(option) }
                    }
                    .padding(.trailing, 2)
                }
                .frame(height: listHeight)
                if filtered.isEmpty {
                    Text(L("Nothing matches “%@”.", filter)).font(.caption).foregroundStyle(.secondary)
                }
            } else if isLoading {
                Text(L("Asking the provider…")).font(.caption).foregroundStyle(.secondary)
            } else if result != nil, failure == nil, result?.error == nil {
                Text(L("This provider lists no models — type the id you want."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let message = failure ?? result?.error {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(Color.knodeBad)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if result?.cached == true, let at = result?.cachedAt {
                Text(L("Cached — the service last asked at %@.", shortTime(at)))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            if let note = result?.note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Text(inherited.isEmpty
                    ? L("Picking one fills the field — Save & apply writes it to the workspace config.")
                    : L("Empty follows the provider (%@). Picking one pins it instead.", inherited))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                if !text.isEmpty {
                    Button(L("Clear")) { text = ""; isShowing = false }
                        .buttonStyle(.link)
                        .font(.caption)
                }
            }
        }
        .padding(14)
        .frame(width: 430)
    }

    private func row(_ option: ModelOption) -> some View {
        Button {
            text = option.id
            isShowing = false
        } label: {
            HStack(spacing: 8) {
                Text(option.id).font(.system(size: 12, design: .monospaced))
                if let label = option.label {
                    Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer()
                if option.id == text { Image(systemName: "checkmark").font(.caption).foregroundStyle(Color.knodeCyan) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(option.id == text ? Color.knodeCyan.opacity(0.12) : Color.clear, in: RoundedRectangle(cornerRadius: 6))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var options: [ModelOption] { result?.models ?? [] }

    /// Tall enough to read, short enough to stay a dropdown: one row is 25pt.
    private var listHeight: CGFloat {
        min(max(CGFloat(filtered.count) * 25, 25), 260)
    }

    private var filtered: [ModelOption] {
        let needle = filter.trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return options }
        return options.filter { $0.id.lowercased().contains(needle) || ($0.label ?? "").lowercased().contains(needle) }
    }

    private func reload(force: Bool = false) async {
        await catalog.load(key, refresh: force, using: load)
    }

    /// Just the clock time: the date is never useful for a list minutes old.
    private func shortTime(_ iso: String) -> String {
        guard let date = ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .omitted, time: .standard)
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "api": L("from the endpoint")
        case "cli": L("from the CLI")
        default: "suggestions"
        }
    }
}

/// The CLI executable is an override: the service resolves the command on its
/// own PATH first — which the desktop app augments with the usual install
/// directories — so the field only earns space when that lookup fails or the
/// user wants to pin one specific binary.
private struct CliExecutableField: View {
    let tool: CliTool?
    @Binding var path: String
    @State private var editing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            if let tool {
                if let found = tool.path, path.isEmpty, !editing {
                    resolvedRow(tool, found)
                } else {
                    overrideField(tool)
                }
            } else {
                FieldLabel(L("CLI executable")) { TextField(L("Use command from PATH"), text: $path) }
            }
        }
    }

    private func resolvedRow(_ tool: CliTool, _ found: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "checkmark.circle.fill").foregroundStyle(Color.knodeGood)
            VStack(alignment: .leading, spacing: 1) {
                Text(L("Runs %@ from PATH — nothing to fill in", tool.command))
                    .font(.caption.weight(.semibold))
                Text(found)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer()
            Button(L("Pin a path…")) { editing = true }
                .buttonStyle(.link)
                .font(.caption)
        }
    }

    @ViewBuilder
    private func overrideField(_ tool: CliTool) -> some View {
        FieldLabel(L("CLI executable")) {
            TextField(tool.path ?? "/full/path/to/\(tool.command)", text: $path)
        }
        if tool.path == nil {
            Label(L("%@ is not on the service PATH — enter its full path.", tool.command), systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(Color.knodeBad)
                .fixedSize(horizontal: false, vertical: true)
        } else if !path.isEmpty || editing {
            Button(L("Use %@ from PATH instead", tool.command)) {
                path = ""
                editing = false
            }
            .buttonStyle(.link)
            .font(.caption)
        }
    }
}

/// One row of the providers table: a scannable line that opens to the form for
/// that provider. Rows stay closed by default, so the section costs one line
/// per provider however many are configured.
private struct ProviderRow<Detail: View>: View {
    let kind: String
    let color: Color
    let isDefault: Bool
    @Binding var label: String
    let providerName: String
    let summary: String
    let id: String
    @Binding var expanded: Bool
    /// nil for a row that must not be removed — the last LLM connection, and
    /// the last embedding provider, since something has to answer and embed.
    let remove: (() -> Void)?
    /// nil when this row cannot be made the default: it already is, or its
    /// kind picks its default another way.
    var makeDefault: (() -> Void)? = nil
    @ViewBuilder let detail: Detail

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    withAnimation(.easeOut(duration: 0.14)) { expanded.toggle() }
                } label: {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 14)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(expanded ? L("Collapse %@", label) : L("Expand %@", label))

                RouteBadge(label: kind, color: color)
                    .frame(width: 56, alignment: .leading)

                TextField(L("Name this provider"), text: $label)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 210)

                if isDefault {
                    RouteBadge(label: L("Default"), color: color)
                } else if let makeDefault {
                    Button(L("Make default"), action: makeDefault)
                        .buttonStyle(.link)
                        .font(.system(size: 10))
                        .help(L("Every job that names no provider of its own moves here"))
                }

                Text(providerName)
                    .font(.callout)
                    .frame(width: 170, alignment: .leading)
                    .lineLimit(1)

                Text(summary.isEmpty ? L("No model set") : summary)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(summary.isEmpty ? .tertiary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 8)

                Text(id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)

                Button(role: .destructive) { remove?() } label: { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .disabled(remove == nil)
                    .opacity(remove == nil ? 0.25 : 1)
                    .help(remove == nil ? L("This provider cannot be removed") : L("Remove this provider"))
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 9)

            if expanded {
                detail
                    .padding(.horizontal, 16)
                    .padding(.top, 2)
                    .padding(.bottom, 16)
            }
        }
        .background(expanded ? color.opacity(0.04) : Color.clear)
    }
}

/// The endpoint and credentials of one embedding provider.
private struct EmbeddingProviderFields: View {
    @Binding var entry: EmbeddingConnection
    let route: String
    let load: (Bool) async throws -> ModelListResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Provider")) {
                        Picker(L("Provider"), selection: $entry.provider) {
                            Text(L("Local hashing · offline")).tag("local")
                            Text(L("OpenAI-compatible API")).tag("openai")
                            Text(L("Volcengine Ark · multimodal")).tag("ark-multimodal")
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: entry.provider == "ark-multimodal" ? "ep-…" : "text-embedding-3-small",
                        text: $entry.model,
                        providerKey: entry.provider,
                        disabled: entry.provider == "local",
                        route: route,
                        load: load
                    )
                }
                GridRow {
                    FieldLabel(L("Base URL")) {
                        TextField("https://api.openai.com/v1", text: $entry.baseUrl)
                            .disabled(entry.provider == "local")
                    }
                    FieldLabel(L("API key")) {
                        SecureField("env:OPENAI_API_KEY", text: $entry.apiKey)
                            .disabled(entry.provider == "local")
                    }
                }
                GridRow {
                    FieldLabel(L("Dimensions")) {
                        TextField(L("Dimensions"), value: $entry.dimensions, format: .number)
                    }
                    Toggle(L("Send dimensions with API requests"), isOn: $entry.sendDimensions)
                        .toggleStyle(.checkbox)
                        .disabled(entry.provider == "local")
                }
            }
            Text(embeddingNote(entry.provider))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// The endpoint and credentials of one LLM provider — the default one and every
/// extra connection are the same form.
private struct LlmProviderFields: View {
    @Binding var provider: String
    @Binding var model: String
    @Binding var baseUrl: String
    @Binding var apiKey: String
    @Binding var cliPath: String
    @Binding var effort: String
    let cliTools: [String: CliTool]
    let route: String
    let load: (Bool) async throws -> ModelListResponse

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            GridRow {
                FieldLabel(L("Provider")) {
                    Picker(L("Provider"), selection: $provider) {
                        Text(L("OpenAI-compatible API")).tag("openai")
                        Text(L("Codex CLI")).tag("codex-cli")
                        Text(L("Claude Code CLI")).tag("claude-cli")
                        Text(L("Cursor Agent CLI")).tag("cursor-cli")
                    }
                    .labelsHidden()
                }
                ModelField(
                    placeholder: provider == "openai" ? "gpt-4.1-mini" : L("Use CLI default"),
                    text: $model,
                    providerKey: provider,
                    route: route,
                    load: load
                )
            }
            if provider == "openai" {
                GridRow {
                    FieldLabel(L("Base URL")) { TextField("https://api.openai.com/v1", text: $baseUrl) }
                    FieldLabel(L("API key")) { SecureField("env:OPENAI_API_KEY", text: $apiKey) }
                }
            } else {
                GridRow {
                    FieldLabel(L("Reasoning effort")) {
                        Picker(L("Reasoning effort"), selection: $effort) {
                            ForEach(EffortLevel.all, id: \.0) { Text(L($0.1)).tag($0.0) }
                        }
                        .labelsHidden()
                    }
                }
                GridRow {
                    CliExecutableField(tool: cliTools[provider], path: $cliPath)
                        .gridCellColumns(2)
                }
            }
            GridRow {
                Text(llmProviderNote(provider))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .gridCellColumns(2)
            }
        }
    }
}

/**
 * The model a route runs with when it names none of its own — the client-side
 * mirror of the service's `resolveRoutedLlmConfig`.
 *
 * Shown as a Model field's placeholder and never written: an empty `model`
 * means "follow this provider", so pinning the string would stop the route
 * tracking the provider's own model, which is what named connections are for.
 */
@MainActor
func inheritedRouteModel(_ use: String, connections: [LLMConnection], defaultModel: String) -> String {
    if let connection = connections.first(where: { $0.id == use }) { return connection.model }
    // '' and 'default' follow whichever connection is the default; a bare CLI
    // name brings its own default, which is not a string we can name
    return (use.isEmpty || use == "default") ? defaultModel : ""
}

/**
 * The same for an agent spec, which may be an agent *name* — and a name can
 * legitimately be `default`, so this never shares a lookup with the route rule.
 */
@MainActor
func inheritedAgentModel(_ spec: String, agents: [AgentDefinition], connections: [LLMConnection], defaultModel: String) -> String {
    let wanted = spec.trimmingCharacters(in: .whitespaces)
    if let agent = agents.first(where: { $0.name == wanted }) {
        return agent.model.isEmpty
            ? inheritedRouteModel(agent.executor, connections: connections, defaultModel: defaultModel)
            : agent.model
    }
    return inheritedRouteModel(wanted, connections: connections, defaultModel: defaultModel)
}

/// What this provider needs, and what an empty model means for it. Used to sit
/// on the default's row alone; every row can be the default now.
@MainActor
func llmProviderNote(_ provider: String) -> String {
    switch provider {
    case "codex-cli": L("Uses your existing Codex login for a read-only one-shot request.")
    case "claude-cli": L("Uses your existing Claude Code login for one non-interactive turn.")
    case "cursor-cli": L("Uses your existing Cursor Agent login in headless print mode.")
    default: L("Any OpenAI-compatible chat endpoint works (OpenAI, DeepSeek, Ollama, vLLM, SiliconFlow…). Use env:VAR_NAME to keep the key out of the config file. An empty model disables LLM features; the deterministic pipeline keeps running.")
    }
}

@MainActor
func embeddingProviderName(_ provider: String) -> String {
    switch provider {
    case "local": L("Local hashing · offline")
    case "openai": L("OpenAI-compatible API")
    case "ark-multimodal": L("Volcengine Ark · multimodal")
    default: provider
    }
}

@MainActor
func embeddingNote(_ provider: String) -> String {
    switch provider {
    case "local":
        return L("The local hashing embedder is private, offline, and ready immediately.")
    case "ark-multimodal":
        return L("Ark posts to /embeddings/multimodal and returns one vector per request, so Base URL ends at /api/v3 and Model is the endpoint id (ep-…). Dimensions must match the model — doubao-embedding-vision is 2048, or 1024 when the dimensions parameter is sent.")
    default:
        return L("Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep keys out of the config file.")
    }
}

/// The reasoning-effort ladder, shared by every control that offers one: a
/// provider row here, a research profile, a role, a chat. value → English
/// label; the label goes through `L` at render time.
enum EffortLevel {
    static let all: [(String, String)] = [
        ("default", "CLI default"),
        ("low", "Low"),
        ("medium", "Medium"),
        ("high", "High"),
        ("xhigh", "Extra high"),
        ("max", "Max (claude & codex; cursor → high)"),
    ]
}

/// A caption above a control, shared by every settings card.
struct FieldLabel<Content: View>: View {
    let label: String
    @ViewBuilder let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            content
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
    }
}

/// Picks which configured provider runs a stage, plus an optional model override.
private struct StagePicker: View {
    @Binding var route: RoutedLLMConfig
    let connections: [LLMConnection]
    let defaultProvider: String
    /// The default connection's model, for the field's inherited placeholder.
    let defaultModel: String
    let routeKey: String
    let load: (Bool) async throws -> ModelListResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FieldLabel(L("Run with")) {
                Picker(L("Run with"), selection: $route.use) {
                    Text(L("Default LLM provider")).tag("")
                    ForEach(connections) { connection in
                        Text(connection.label).tag(connection.id)
                    }
                }
                .labelsHidden()
            }
            ModelField(
                placeholder: L("Optional · use its model"),
                text: $route.model,
                inherited: inheritedRouteModel(route.use, connections: connections, defaultModel: defaultModel),
                providerKey: route.use,
                route: routeKey,
                load: load
            )
            Text(runningOn)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var runningOn: String {
        guard let connection = connections.first(where: { $0.id == route.use }) else {
            return L("Runs on the default provider (%@).", providerName(defaultProvider))
        }
        let endpoint = connection.provider == "openai"
            ? (connection.baseUrl.isEmpty ? L("no endpoint set") : connection.baseUrl)
            : providerName(connection.provider)
        return L("Runs on %@.", endpoint)
    }
}

/// A stage whose provider is not chosen here — it follows section 01.
private struct StagePin: View {
    let value: String
    let hint: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(L("Runs on"))
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout.weight(.medium))
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(hint)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct TestResultRow: View {
    let label: String
    let result: RouteTestResult?

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
                .foregroundStyle(color)
            Text(label).fontWeight(.semibold).frame(width: 132, alignment: .leading)
            Text(detail).foregroundStyle(.secondary)
            Spacer()
        }
        .font(.callout)
        .padding(.vertical, 3)
    }

    private var icon: String {
        guard let result else { return "minus.circle" }
        return result.ok ? "checkmark.circle.fill" : "xmark.circle.fill"
    }

    private var color: Color {
        guard let result else { return .secondary }
        return result.ok ? .knodeGood : .knodeBad
    }

    private var detail: String {
        guard let result else { return "Not tested" }
        if let error = result.error { return error }
        if result.enabled == false { return result.note ?? "Route disabled" }
        var parts: [String] = []
        if result.inherited == true { parts.append("inherited") }
        if let model = result.model { parts.append(model) }
        if let dimensions = result.dimensions { parts.append("\(dimensions)d") }
        if let ms = result.ms { parts.append("\(ms)ms") }
        if let sample = result.sample?.trimmingCharacters(in: .whitespacesAndNewlines), !sample.isEmpty { parts.append("replied “\(sample)”") }
        return parts.isEmpty ? "Connected" : parts.joined(separator: " · ")
    }
}

/// The five stages a document passes through, in order. Declaring them once
/// keeps the flow nodes, the inspector and the per-stage rates from drifting
/// apart — they used to be five hand-written blocks.
enum PipelineStage: Int, CaseIterable, Identifiable {
    case convert = 1, index, extract, synthesize, answer

    var id: Int { rawValue }
    var step: Int { rawValue }

    @MainActor var title: String {
        switch self {
        case .convert: L("Convert")
        case .index: L("Index")
        case .extract: L("Extract")
        case .synthesize: L("Synthesize")
        case .answer: L("Answer")
        }
    }

    @MainActor var requirement: String {
        switch self {
        case .convert: L("Vision")
        case .index: L("Embedding")
        case .extract: L("Volume")
        case .synthesize: L("Quality")
        case .answer: L("Interactive")
        }
    }

    /// Cyan is the index and its embeddings; violet is everything an LLM runs.
    var color: Color { self == .index ? .knodeCyan : .knodeViolet }

    @MainActor var detail: String {
        switch self {
        case .convert: L("Images and scanned PDF pages become searchable Markdown.")
        case .index: L("Every chunk becomes a vector for semantic and hybrid recall.")
        case .extract: L("Names entities, relations and factual claims in changed documents.")
        case .synthesize: L("Turns hot entity clusters into readable, linked Concept pages.")
        case .answer: L("Document summaries in the wiki, and the nightly Dream analysis.")
        }
    }

    @MainActor var requirementDetail: String {
        switch self {
        case .convert:
            L("The model has to see pixels: an API provider gets the image inline, codex takes --image, and claude and cursor read the file with their own tools. A text-only model fails here. Changing this re-converts every image and scanned page.")
        case .index:
            L("Not an LLM — it uses one of the embedding providers from section 01. Changing which one, or its model or dimensions, re-embeds the whole corpus.")
        case .extract:
            L("The busiest stage — it runs on every changed document, bounded by the daily budget and the batch size here. A fast, cheap model that returns clean JSON is usually the right trade.")
        case .synthesize:
            L("Far fewer calls than Extract — only hot clusters reach it — and the output is prose people read, so a stronger model pays for itself here.")
        case .answer:
            L("Always the default provider — these are the jobs that never picked one of their own. Ask no longer runs here: every question is an agent session, configured under Providers & Agents.")
        }
    }
}

@MainActor
func providerName(_ provider: String) -> String {
    switch provider {
    case "inherit": L("Default model")
    case "openai": L("OpenAI-compatible API")
    case "codex-cli": L("Codex CLI")
    case "claude-cli": L("Claude Code CLI")
    case "cursor-cli": L("Cursor Agent CLI")
    default: provider
    }
}
