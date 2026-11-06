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
    /// Which stage the form beside the pipeline rail is showing.
    @State private var selectedStage: PipelineStage = .convert
    @State private var hoveredStage: PipelineStage?
    /// Model lists, shared by every picker on the screen.
    @StateObject private var catalog = ModelCatalog()
    /// The Playbooks tab's groups and open draft, kept across the other tabs.
    @StateObject private var playbooks = PlaybooksEditor()
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
    /// The languages the Translate stage can write: the service's list, or
    /// the built-in copy of it until that arrives or when it never does.
    @State private var languageCatalog: [ContentLanguage] = ContentLanguage.builtin

    var body: some View {
        VStack(spacing: 0) {
            SectionTabs(section: .settings) { pageActions }
            Divider()
            content
        }
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

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                if isLoading && config == nil {
                    ProgressView("Loading model routes…")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 80)
                } else if config != nil {
                    // one section per sub-tab; the results below stay put,
                    // because `Test stages` tests every stage
                    switch model.selectedTab {
                    case .pipeline: pipelineSection
                    case .research: researchSection
                    case .chat: askSection
                    case .playbooks: PlaybooksSettingsSection(editor: playbooks)
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
        // A table row wider than a narrow window stays inside the scroll view
        // instead of widening the whole screen, which pushed Save & apply at
        // the strip's right end off the window.
        .frame(minWidth: 0, maxWidth: .infinity)
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
    }

    /// What the whole screen does, at the right end of the tab strip: always
    /// in reach, however far down the page an edit happened. It used to sit
    /// under a hero title that only restated the tab.
    private var pageActions: some View {
        HStack(spacing: 10) {
            // left of the buttons, so they do not move while it spins
            if isWorking { ProgressView().controlSize(.small) }
            Picker(L("Language"), selection: $model.language) {
                ForEach(AppLanguage.allCases) { Text($0.label).tag($0) }
            }
            .labelsHidden()
            .frame(width: 148)
            .help(L("Interface language — prompts and pages keep the language they are written in"))
            if !model.maySaveSettings {
                // the service refuses a member's changes; say so instead of offering them
                Label(L("Read-only: settings are an administrator's"), systemImage: "lock")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if model.selectedTab != .playbooks {
                // a playbook saves from its own editor: these two are the config's
                Button(L("Test stages")) { Task { await test() } }
                    .disabled(config == nil || isWorking)
                    .help(L("Sends one real request per configured stage, before you save."))
                Button(L("Save & apply")) { Task { await save() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.knodeCyan)
                    .disabled(config == nil || isWorking)
            }
        }
    }

    // MARK: - 01 · Providers

    /// Every model endpoint and credential lives here, once, as one table:
    /// which embedding models exist, which LLMs exist, and which of each is the
    /// default. A row opens to its own form, so the page stays scannable
    /// however many are configured. The agents that run on them — and the
    /// coding-agent CLIs, which are agents and not models — get the table below.
    private var providersSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                title: L("Models"),
                detail: L("Each model endpoint and its key, once. Ingest stages pick from this list, and a deepagents agent below runs on one of them.")
            )
            EmbeddingRoutingSection(config: $config)
            LocalEmbeddingSection(config: $config)
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
            // the same give as the rows below, so a narrow window squeezes
            // the header with them instead of stacking "Model" letter by letter
            Text(L("Kind"))
                .frame(width: 74, alignment: .leading)
            Text(L("Name"))
                .frame(minWidth: 150, maxWidth: 210, alignment: .leading)
                .layoutPriority(1)
            Text(L("Provider"))
                .frame(minWidth: 90, maxWidth: 170, alignment: .leading)
            Text(L("Model"))
                .lineLimit(1)
            Spacer(minLength: 8)
            Menu {
                Button(L("LLM · OpenAI-compatible API")) { addConnection() }
                Button(L("Embedding")) { addEmbeddingProvider() }
            } label: {
                Label(L("Add model"), systemImage: "plus")
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
            isDefault: config?.embeddingPool?.enabled != true && entry.id == config?.embeddingUse,
            label: binding(\.embeddingProviders)[index].label,
            providerName: embeddingProviderName(entry.provider),
            summary: embeddingRowSummary(entry),
            expanded: expandedBinding(entry.id),
            // Something has to embed, so the last one cannot be removed.
            remove: (config?.embeddingProviders.count ?? 0) > 1 ? { removeEmbeddingProvider(id: entry.id) } : nil,
            uses: embeddingUses(entry)
        ) {
            EmbeddingProviderFields(
                entry: binding(\.embeddingProviders)[index],
                route: "embedding:\(entry.id)",
                load: { refresh in try await modelList(route: "embedding:\(entry.id)", refresh: refresh) }
            )
            if entry.provider == "openai" {
                EmbeddingKeyRoutingFields(
                    entry: binding(\.embeddingProviders)[index],
                    load: { refresh in try await modelList(route: "embedding:\(entry.id)", refresh: refresh) },
                    test: { try await model.client().testEmbedding(config!, id: entry.id) }
                )
            }
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
            expanded: expandedBinding(connection.id),
            // something has to answer, so the last one cannot go
            remove: (config?.connections.count ?? 0) > 1 ? { removeConnection(id: connection.id) } : nil,
            makeDefault: isDefault ? nil : { config?.llmUse = connection.id },
            uses: modelUses(connection.id)
        ) {
            LlmProviderFields(
                model: binding(\.connections)[index].model,
                baseUrl: binding(\.connections)[index].baseUrl,
                apiKey: binding(\.connections)[index].apiKey,
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
        let summary = model.isEmpty ? L("%@d", String(entry.dimensions)) : "\(model) · \(entry.dimensions)d"
        return summary + (entry.enabled == false ? " · " + L("Disabled") : "") +
            (entry.catalog == nil ? "" : " · " + L("%@ models", String(entry.catalog!.count)))
    }

    // MARK: - 02 · Pipeline

    /// The six stages as a rail, top to bottom in the order a document passes
    /// through them, with the selected stage's form beside it. A node carries
    /// what a person checks at a glance — where it runs and how fast — and the
    /// form holds everything else. The nodes used to be a row over the form,
    /// which an ordinary window wrapped to three and two, and which put every
    /// control well below the node that opened it.
    private var pipelineSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                title: L("How documents get processed"),
                detail: L("A document moves down this list. The stages ask different things of a model, which is why each one can run somewhere else.")
            )
            HStack(alignment: .top, spacing: 0) {
                stageRail.frame(width: 256)
                Divider()
                stageInspector
            }
            .knodeCard(padding: 0)
        }
    }

    private var stageRail: some View {
        let stages = PipelineStage.allCases
        return VStack(alignment: .leading, spacing: 0) {
            ForEach(stages) { stage in
                if stage != stages.first { stageArrow }
                stageNode(stage)
            }
        }
        .padding(12)
    }

    /// Under the step numbers, so the six read down one column.
    private var stageArrow: some View {
        Image(systemName: "arrow.down")
            .font(.system(size: 8, weight: .semibold))
            .foregroundStyle(.tertiary)
            .frame(width: 16, height: 14)
            // a node's padding, which is where its step number starts
            .padding(.leading, 11)
    }

    private func stageNode(_ stage: PipelineStage) -> some View {
        let selected = selectedStage == stage
        let target = stageTarget(stage)
        return Button {
            selectedStage = stage
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(stage.step)")
                    .font(.system(size: 9, weight: .bold, design: .monospaced))
                    .foregroundStyle(stage.color)
                    .frame(width: 16, height: 16)
                    .background(stage.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(stage.title).font(.system(size: 12, weight: .semibold))
                        Spacer(minLength: 4)
                        RouteBadge(label: stage.requirement, color: stage.color)
                    }
                    // two lines, because they truncate differently: a provider's
                    // name identifies itself by its head, a model id by both ends
                    VStack(alignment: .leading, spacing: 2) {
                        Text(target.provider)
                            .foregroundStyle(.secondary)
                            .truncationMode(.tail)
                        Text(target.model.isEmpty ? L("its own model") : target.model)
                            .foregroundStyle(.tertiary)
                            .truncationMode(.middle)
                    }
                    .font(.system(size: 10, design: .monospaced))
                    .lineLimit(1)
                    HStack(spacing: 4) {
                        // an empty rate keeps the line's height, so the nodes
                        // stay one size, but takes no gap before an effort
                        if !stageRate(stage).isEmpty || stageTuning(stage) == nil { Text(stageRate(stage)) }
                        // the effort and Fast the model field's chip sets, at a glance
                        if let tuning = stageTuning(stage) {
                            if !stageRate(stage).isEmpty, !tuning.effort.isEmpty { Text("·") }
                            if tuning.fast { Image(systemName: "bolt.fill").font(.system(size: 8, weight: .bold)) }
                            if !tuning.effort.isEmpty { Text(tuning.effort) }
                        }
                    }
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                }
            }
            .help(target.line)
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(selected ? stage.color.opacity(0.1) : Color.black.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
            .overlay {
                RoundedRectangle(cornerRadius: 10)
                    .stroke(
                        selected ? stage.color.opacity(0.55) : Color.white.opacity(hoveredStage == stage ? 0.18 : 0.07),
                        lineWidth: selected ? 1.5 : 1
                    )
            }
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .onHover { inside in
            if inside { hoveredStage = stage } else if hoveredStage == stage { hoveredStage = nil }
        }
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }

    /// The selected stage: what it does, then where it runs and how fast, and
    /// last what changing it costs. The controls come straight after the
    /// one-line summary, level with the rail — they used to sit under a long
    /// caveat, split between the far left and the far right of the card.
    private var stageInspector: some View {
        let stage = selectedStage
        return VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(stage.title).font(.headline)
                    RouteBadge(label: stage.requirement, color: stage.color)
                }
                Text(stage.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            VStack(alignment: .leading, spacing: 18) {
                stageControl(stage)
                stageRates(stage)
            }
            // a form's width, not the pane's: a picker and a count read badly
            // stretched across a wide window
            .frame(maxWidth: 440, alignment: .leading)
            Label {
                Text(stage.requirementDetail).fixedSize(horizontal: false, vertical: true)
            } icon: {
                Image(systemName: "info.circle")
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
            .frame(maxWidth: 560, alignment: .leading)
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private func stageControl(_ stage: PipelineStage) -> some View {
        switch stage {
        case .convert:
            StagePicker(
                route: binding(\.extraction.documentLlm),
                models: config?.connections ?? [],
                agents: routeAgents,
                defaultTarget: defaultTarget,
                routeKey: "documentLlm",
                load: { refresh in try await modelList(route: "documentLlm", refresh: refresh) }
            )
        case .index:
            VStack(alignment: .leading, spacing: 10) {
                if let pool = config?.embeddingPool, pool.enabled {
                    Label(L("Embedding model pool"), systemImage: "arrow.triangle.branch").foregroundStyle(Color.knodeCyan)
                    Text("\(pool.model) · \(pool.dimensions)d · \(config?.embeddingProviders.filter { embeddingMatchesPool($0, pool) }.count ?? 0) keys")
                    Text(L("Manage the pool and key limits in Providers & Agents.")).font(.caption).foregroundStyle(.secondary)
                } else {
                FieldLabel(L("Run with")) {
                    Picker(L("Run with"), selection: binding(\.embeddingUse)) {
                        ForEach(config?.embeddingProviders ?? []) { entry in
                            Text(entry.label).tag(entry.id)
                        }
                    }
                    .labelsHidden()
                }
                Text(L("Enable a model pool in Providers & Agents to share compatible keys. Changing the model re-embeds the workspace."))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        case .extract:
            StagePicker(
                route: binding(\.extraction.entityLlm),
                models: config?.connections ?? [],
                agents: routeAgents,
                defaultTarget: defaultTarget,
                routeKey: "entityLlm",
                load: { refresh in try await modelList(route: "entityLlm", refresh: refresh) }
            )
        case .summarize:
            StagePicker(
                route: binding(\.extraction.summaryLlm),
                models: config?.connections ?? [],
                agents: routeAgents,
                defaultTarget: defaultTarget,
                routeKey: "summaryLlm",
                load: { refresh in try await modelList(route: "summaryLlm", refresh: refresh) }
            )
        case .judge:
            VStack(alignment: .leading, spacing: 18) {
                StagePicker(
                    route: binding(\.extraction.judgeLlm),
                    models: config?.connections ?? [],
                    agents: routeAgents,
                    defaultTarget: defaultTarget,
                    routeKey: "judgeLlm",
                    load: { refresh in try await modelList(route: "judgeLlm", refresh: refresh) }
                )
                reviewModes
            }
        case .translate:
            if config?.languages == nil {
                // a service from before content languages has neither the
                // stage nor the languages, and would drop both on a save
                Text(L("This service has no Translate stage yet — update knode-os on it to translate documents."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                VStack(alignment: .leading, spacing: 18) {
                    StagePicker(
                        route: binding(\.extraction.translateLlm),
                        models: config?.connections ?? [],
                        agents: routeAgents,
                        defaultTarget: defaultTarget,
                        routeKey: "translateLlm",
                        load: { refresh in try await modelList(route: "translateLlm", refresh: refresh) }
                    )
                    contentLanguages
                }
            }
        }
    }

    /// What the Translate stage translates into: the workspace's content
    /// languages. They are the workspace's, not this Mac's — the interface
    /// language at the top of the page is a person's own and changes no
    /// document — and each reader picks among them in the file view.
    private var contentLanguages: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle(L("Translate documents into the primary language"), isOn: languagesEnabled)
                .toggleStyle(.checkbox)
            FieldLabel(L("Primary language")) {
                Picker(L("Primary language"), selection: primaryLanguage) {
                    if config?.languages?.primary.isEmpty != false {
                        Text(L("Not chosen")).tag("")
                    }
                    ForEach(languageCatalog) { language in
                        Text(languageName(language)).tag(language.code)
                    }
                }
                .labelsHidden()
            }
            FieldLabel(L("Secondary languages")) {
                FlowLayout(spacing: 12) {
                    ForEach(languageCatalog.filter { $0.code != config?.languages?.primary }) { language in
                        Toggle(languageName(language), isOn: secondaryLanguage(language.code))
                            .toggleStyle(.checkbox)
                    }
                }
            }
            Text(L("Every document in another language is translated into the primary one in the background; into a secondary one only when a reader asks. Originals are never changed, and summaries are written in the primary language."))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// A language by its own name, then by the interface's where that reads
    /// differently — "日本語 · Japanese", but "English" alone.
    private func languageName(_ language: ContentLanguage) -> String {
        let local = L(language.english)
        return local == language.native ? language.native : "\(language.native) · \(local)"
    }

    /// Turning translation on with no primary language picked yet pre-fills
    /// the interface's — only a pre-fill, shown in the picker below and saved
    /// with everything else, since the service refuses one without the other.
    private var languagesEnabled: Binding<Bool> {
        Binding(
            get: { config?.languages?.enabled ?? false },
            set: { on in
                guard config?.languages != nil else { return }
                config!.languages!.enabled = on
                if on, config!.languages!.primary.isEmpty { config!.languages!.primary = L10n.isChinese ? "zh" : "en" }
            }
        )
    }

    /// The primary language is never also a secondary one.
    private var primaryLanguage: Binding<String> {
        Binding(
            get: { config?.languages?.primary ?? "" },
            set: { code in
                guard config?.languages != nil else { return }
                config!.languages!.primary = code
                config!.languages!.secondary.removeAll { $0 == code }
            }
        )
    }

    /// Kept in the catalog's order, which is the order the switcher lists them in.
    private func secondaryLanguage(_ code: String) -> Binding<Bool> {
        Binding(
            get: { config?.languages?.secondary.contains(code) ?? false },
            set: { on in
                guard config?.languages != nil else { return }
                var picked = Set(config!.languages!.secondary)
                if on { picked.insert(code) } else { picked.remove(code) }
                let order = languageCatalog.map(\.code)
                config!.languages!.secondary = picked.sorted { (order.firstIndex(of: $0) ?? .max) < (order.firstIndex(of: $1) ?? .max) }
            }
        )
    }

    /// What the Judge stage does with its verdicts. The duplicate reviews (of
    /// entities and of claims) run after every extraction pass and again at
    /// night; the disputed-claim review at night.
    private var reviewModes: some View {
        VStack(alignment: .leading, spacing: 10) {
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                GridRow {
                    FieldLabel(L("Duplicate entities")) {
                        Picker(L("Duplicate entities"), selection: binding(\.review.llmJudge)) {
                            Text(L("Off")).tag("off")
                            Text(L("Suggest merges")).tag("suggest")
                            Text(L("Merge confident pairs")).tag("auto")
                        }
                        .labelsHidden()
                    }
                    FieldLabel(L("Disputed claims")) {
                        Picker(L("Disputed claims"), selection: binding(\.review.claims)) {
                            Text(L("Off")).tag("off")
                            Text(L("Suggest a verdict")).tag("suggest")
                        }
                        .labelsHidden()
                    }
                }
                GridRow {
                    FieldLabel(L("Duplicate claims")) {
                        Picker(L("Duplicate claims"), selection: binding(\.review.claimMerge)) {
                            Text(L("Off")).tag("off")
                            Text(L("Suggest merges")).tag("suggest")
                            Text(L("Merge confident pairs")).tag("auto")
                        }
                        .labelsHidden()
                    }
                    Color.clear.frame(height: 1)
                }
            }
            Text(L("After each extraction pass the entities and claims it wrote are checked for duplicates, and everything again overnight; a merge can always be undone. Disputed claims are reviewed overnight."))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
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
        case .extract:
            VStack(alignment: .leading, spacing: 10) {
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                    GridRow {
                        FieldLabel(L("Parallel calls")) {
                            TextField(L("Parallel calls"), value: binding(\.extraction.concurrency), format: .number)
                        }
                        FieldLabel(L("Calls per pass")) {
                            TextField(L("Calls per pass"), value: binding(\.extraction.batchSize), format: .number)
                        }
                    }
                    GridRow {
                        FieldLabel(L("Catch-up before initializing (minutes)")) {
                            TextField("15", value: initCatchUpMinutes, format: .number)
                        }
                        Color.clear.frame(height: 1)
                    }
                }
                Text(L("Initializing the wiki first extracts whatever is still queued, for up to this long; the rest is left to the background passes."))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(L("A document longer than %@ characters is read in segments, one call each; it may take several passes and is written once every segment is in.", (config?.extraction.segmentChars ?? 12_000).formatted()))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
                if let queued = model.stats?.extractionQueue, queued > 0 {
                    Text(L("Queue: %@ documents, %@ calls left", String(queued), String(model.stats?.extractionSegments ?? queued)))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Toggle(L("Extract factual claims alongside entities"), isOn: binding(\.extraction.claims))
                    .toggleStyle(.checkbox)
            }
        case .summarize:
            Text(L("Runs in Extract's background pass, with its calls per pass and parallel calls."))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        case .judge:
            EmptyView()
        case .translate:
            if config?.languages != nil {
                VStack(alignment: .leading, spacing: 10) {
                    // the second caption wraps to two lines; level fields read better than level captions
                    Grid(alignment: .bottomLeading, horizontalSpacing: 16, verticalSpacing: 10) {
                        GridRow {
                            FieldLabel(L("Parallel calls")) {
                                TextField(L("Parallel calls"), value: translateConcurrency, format: .number)
                            }
                            FieldLabel(L("Longest document translated without a request")) {
                                TextField(L("Longest document translated without a request"), value: languagesBinding(\.maxChars), format: .number)
                            }
                        }
                    }
                    Text(L("Parallel calls start at Extract's; 0 leaves translations to remote workers. The longest document is in characters, 0 for no limit — a longer one is translated when a reader asks for it."))
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let translations = model.processing?.translations, translations.enabled {
                        Text(translations.queueLine)
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    /// This machine's translation slots: unset, they are Extract's parallel
    /// calls, which is what the field shows until someone types a number.
    private var translateConcurrency: Binding<Int> {
        Binding(
            get: { config?.extraction.translateConcurrency ?? config?.extraction.concurrency ?? 0 },
            set: { config?.extraction.translateConcurrency = max(0, $0) }
        )
    }

    /// One field of the `languages` block, which only a service that sends it shows.
    private func languagesBinding<Value>(_ keyPath: WritableKeyPath<LanguagesConfig, Value>) -> Binding<Value> {
        Binding(
            get: { (config?.languages ?? LanguagesConfig())[keyPath: keyPath] },
            set: { value in
                guard config?.languages != nil else { return }
                config!.languages![keyPath: keyPath] = value
            }
        )
    }

    /// `batchSize` is optional in the mirror, but the field is a plain number.
    private var embeddingBatchSize: Binding<Int> {
        Binding(
            get: { config?.embeddingPool?.enabled == true ? config!.embeddingPool!.batchSize : config?.activeEmbedding?.batchSize ?? 32 },
            set: { size in
                if config?.embeddingPool?.enabled == true { config?.embeddingPool?.batchSize = size; return }
                guard config != nil, let index = config!.embeddingProviders.firstIndex(where: { $0.id == config!.embeddingUse }) else { return }
                config!.embeddingProviders[index].batchSize = size
            }
        )
    }

    /// The extraction an initialization catches up on before its agent starts,
    /// in minutes. It is extraction, so it sits with the Extract stage, though
    /// the service keeps it as `research.init.extractionMaxMs`.
    private var initCatchUpMinutes: Binding<Int> {
        Binding(
            get: { max(1, (config?.research.initialization.extractionMaxMs ?? 900_000) / 60_000) },
            set: { config?.research.initialization.extractionMaxMs = max(1, $0) * 60_000 }
        )
    }

    private func stageTarget(_ stage: PipelineStage) -> RouteTarget {
        switch stage {
        case .convert: routeSummary(\.extraction.documentLlm)
        case .index: embeddingSummary
        case .extract: routeSummary(\.extraction.entityLlm)
        case .summarize: routeSummary(\.extraction.summaryLlm)
        case .judge: routeSummary(\.extraction.judgeLlm)
        case .translate:
            config == nil || config?.languages != nil ? routeSummary(\.extraction.translateLlm) : RouteTarget(provider: L("Not on this service"))
        }
    }

    /// A stage's own effort and Fast, else its agent's — what runs, as far as
    /// the config says; nil where neither is set or the stage runs on a model.
    private func stageTuning(_ stage: PipelineStage) -> (effort: String, fast: Bool)? {
        guard let config else { return nil }
        let route: RoutedLLMConfig
        switch stage {
        case .convert: route = config.extraction.documentLlm
        case .extract: route = config.extraction.entityLlm
        case .summarize: route = config.extraction.summaryLlm
        case .judge: route = config.extraction.judgeLlm
        case .translate:
            guard config.languages != nil else { return nil }
            route = config.extraction.translateLlm
        case .index: return nil
        }
        guard let target = routeTargets.first(where: { $0.id == route.use }), cliProviderNames.contains(target.provider) else { return nil }
        let effort = route.effort != "default" ? route.effort : target.effort
        let fast = route.speed == "fast" || target.speed == "fast"
        guard effort != "default" || fast else { return nil }
        return (effort == "default" ? "" : EffortLevel.name(effort), fast)
    }

    private func stageRate(_ stage: PipelineStage) -> String {
        guard let config else { return "" }
        return switch stage {
        case .convert: "×\(config.ingest.convertConcurrency)"
        case .index: "×\(config.ingest.concurrency) · \(config.embedding.batchSize ?? 32)/req"
        // Summarize runs in Extract's pass, at its rates
        case .extract, .summarize: "×\(config.extraction.concurrency) · \(config.extraction.batchSize)/pass"
        case .judge: ""
        // its own slots, and the languages it writes, primary first
        case .translate:
            if let languages = config.languages, languages.enabled, !languages.primary.isEmpty {
                "×\(config.extraction.translateConcurrency ?? config.extraction.concurrency) · \(([languages.primary] + languages.secondary).joined(separator: ", "))"
            } else {
                config.languages == nil ? "" : L("Off")
            }
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
                uses: agentUses,
                connections: config?.connections ?? [],
                defaultTarget: defaultTarget,
                cliTools: cliTools,
                isWorking: isWorking,
                add: { runtime in Task { await addAgent(runtime: runtime) } },
                remove: { agentToRemove = $0 },
                loadModels: { agent, refresh in try await agentModelList(agent, refresh: refresh) }
            )
        }
    }

    private func loadAgents() async {
        guard let response = try? await model.client().agents() else { return }
        agents = response.agents
    }

    /// A new agent is written immediately — it is its own file, not part of
    /// the config draft — and its name has to exist before Research can name it.
    ///
    /// deepagents follows the default LLM when the default is a model; when it
    /// is a CLI agent there is nothing to follow, so the first model is pinned.
    private func addAgent(runtime: String) async {
        isWorking = true
        defer { isWorking = false }
        let cli = cliProviderNames.contains(runtime)
        let base = cli ? runtime.replacingOccurrences(of: "-cli", with: "") : "agent"
        var suffix = 1
        let taken = Set(agents.map(\.name) + (config?.connections ?? []).map(\.id))
        while taken.contains("\(base)-\(suffix)") { suffix += 1 }
        let name = "\(base)-\(suffix)"
        let executor = cli
            ? runtime
            : defaultTarget?.provider == "openai" ? ResearchSettingsSection.defaultConnection : (config?.connections.first?.id ?? ResearchSettingsSection.defaultConnection)
        var draft = AgentDefinition(name: name, executor: executor)
        draft.title = cli ? providerName(runtime) : L("New deepagents agent")
        do {
            _ = try await model.client().saveAgent(name, draft.payload)
            await loadAgents()
            statusMessage = L("Agent %@ created", draft.title)
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
            // The service moves research, Ask, a pipeline route and the default
            // off a deleted agent, so read those back rather than leaving a
            // name on screen that is gone.
            if response.reset != true, let fresh = try? await model.client().config() {
                config?.research.agent = fresh.research.agent
                config?.chat.agent = fresh.chat.agent
                config?.llmUse = fresh.llmUse
                config?.llm = fresh.llm
                config?.extraction.entityLlm.use = fresh.extraction.entityLlm.use
                config?.extraction.documentLlm.use = fresh.extraction.documentLlm.use
                config?.extraction.summaryLlm.use = fresh.extraction.summaryLlm.use
                config?.extraction.judgeLlm.use = fresh.extraction.judgeLlm.use
                config?.extraction.translateLlm.use = fresh.extraction.translateLlm.use
            }
            statusMessage = response.reset == true
                ? L("Agent %@ reset to the built-in", agent.title)
                : L("Agent %@ removed", agent.title)
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

    // MARK: - What runs on a row

    /// A row of the two tables: a model by connection id, an agent by name.
    /// The two could share a string; a model wins then, as in `routeTargets`.
    private enum TableRow: Equatable {
        case model(String)
        case agent(String)
    }

    private func tableRow(_ id: String) -> TableRow {
        (config?.connections ?? []).contains { $0.id == id } ? .model(id) : .agent(id)
    }

    /// The badges at the right end of a model row: the pipeline stages and
    /// the deepagents agents that run on it, and Research or Ask when they
    /// name it directly instead of an agent. A row with none runs nothing.
    private func modelUses(_ id: String) -> [RowUse] {
        var uses = [pipelineUse(stages(on: .model(id)))].compactMap { $0 }
        let names = agents
            .filter { agentEndpoint($0, connections: config?.connections ?? [], defaultTarget: defaultTarget)?.id == id }
            .map(agentTitle)
        if !names.isEmpty {
            uses.append(RowUse(label: L("Agents"), color: .knodeCyan, help: L("Agents on this model: %@", listed(names))))
        }
        return uses + specUses(.model(id))
    }

    /// An embedding model has one job — Index — while it is the active one.
    private func embeddingUses(_ entry: EmbeddingConnection) -> [RowUse] {
        if let pool = config?.embeddingPool, pool.enabled {
            return embeddingMatchesPool(entry, pool) ? [RowUse(label: L("Pool"), color: .knodeCyan)] : []
        }
        guard entry.id == config?.activeEmbedding?.id else { return [] }
        return [pipelineUse([.index])].compactMap { $0 }
    }

    /// The same for the agents table, by agent name: the default (a CLI agent
    /// can be it), the stages that call it one-shot, and Research and Ask.
    private var agentUses: [String: [RowUse]] {
        var out: [String: [RowUse]] = [:]
        for agent in agents {
            var uses: [RowUse] = []
            if agent.isCli && agent.name == config?.llmUse { uses.append(RowUse(label: L("Default"), color: .knodeCyan)) }
            if let pipeline = pipelineUse(stages(on: .agent(agent.name))) { uses.append(pipeline) }
            out[agent.name] = uses + specUses(.agent(agent.name))
        }
        return out
    }

    /// The stages that run on a row, in the order a document meets them. A
    /// route names what it runs on; one naming nothing a stage can run on
    /// falls back to the default, as the service's `resolveRoutedLlmConfig`
    /// does. Index is an embedding's.
    private func stages(on row: TableRow) -> [PipelineStage] {
        guard let config else { return [] }
        let fallback = defaultTarget.map { tableRow($0.id) }
        func routed(_ route: RoutedLLMConfig) -> TableRow? {
            let use = route.use.trimmingCharacters(in: .whitespaces)
            guard !use.isEmpty, use != ResearchSettingsSection.defaultConnection,
                  let target = routeTargets.first(where: { $0.id == use }) else { return fallback }
            return tableRow(target.id)
        }
        return PipelineStage.allCases.filter { stage in
            switch stage {
            case .convert: routed(config.extraction.documentLlm) == row
            case .index: false
            case .extract: routed(config.extraction.entityLlm) == row
            case .summarize: routed(config.extraction.summaryLlm) == row
            case .judge: routed(config.extraction.judgeLlm) == row
            // the mirror's copy of Summarize's route on a service without the stage runs nothing
            case .translate: config.languages != nil && routed(config.extraction.translateLlm) == row
            }
        }
    }

    /// One badge for all the stages on a row, naming them on hover. Cyan for
    /// Index and violet for the LLM stages, the colours their nodes have.
    private func pipelineUse(_ stages: [PipelineStage]) -> RowUse? {
        guard let first = stages.first else { return nil }
        return RowUse(label: L("Ingest"), color: first.color, help: L("Ingest stages on this: %@", listed(stages.map(\.title))))
    }

    /// Research and Ask on a row, in the order the service resolves them:
    /// `resolveAgentSpec` for each spec, and for Ask `chatSpec` — its own
    /// agent, else the research agent, else the default model directly.
    private func specUses(_ row: TableRow) -> [RowUse] {
        guard let config else { return [] }
        var uses: [RowUse] = []
        let research = config.research.agent.trimmingCharacters(in: .whitespaces)
        if specRow(research) == row {
            uses.append(RowUse(
                label: L("Research"),
                color: .knodeViolet,
                help: namesAgent(research) ? "" : L("Research runs on this directly rather than through an agent — pick one under Research.")
            ))
        }
        let chat = config.chat.agent.trimmingCharacters(in: .whitespaces)
        let ask = chat.isEmpty ? (research.isEmpty ? ResearchSettingsSection.defaultConnection : research) : chat
        if specRow(ask) == row {
            let help = chat.isEmpty && !research.isEmpty
                ? L("Ask names no agent of its own, so it follows the research agent — give it one under Ask.")
                : namesAgent(ask) ? "" : L("Ask runs on this directly rather than through an agent — give it one under Ask.")
            uses.append(RowUse(label: L("Ask"), color: .knodeCyan, help: help))
        }
        return uses
    }

    /// The row a Research or Ask spec lands on — the client mirror of
    /// `resolveAgentSpec`: an agent by name first, else a model or CLI agent
    /// by id, `default` being the default. A bare CLI name lands on no row.
    private func specRow(_ spec: String) -> TableRow? {
        guard !spec.isEmpty else { return nil }
        if namesAgent(spec) { return .agent(spec) }
        let target = spec == ResearchSettingsSection.defaultConnection ? defaultTarget : llmTargets.first { $0.id == spec }
        return target.map { tableRow($0.id) }
    }

    private func namesAgent(_ spec: String) -> Bool {
        agents.contains { $0.name == spec }
    }

    /// An agent by the name its row shows, never its file name.
    private func agentTitle(_ agent: AgentDefinition) -> String {
        let title = agent.title.trimmingCharacters(in: .whitespaces)
        if !title.isEmpty { return title }
        return agent.isCli ? providerName(agent.executor) : AgentsSettingsSection.deepagents
    }

    private func listed(_ names: [String]) -> String {
        names.joined(separator: L10n.isChinese ? "、" : ", ")
    }

    // MARK: - 03 · Research

    @ViewBuilder
    private var researchSection: some View {
        if config != nil {
            ResearchSettingsSection(
                research: binding(\.research),
                review: binding(\.review),
                profile: $profileDraft,
                dirty: $profileDirty,
                profileSelection: researchProfileBinding,
                summaries: profiles,
                connections: llmTargets,
                agents: agents,
                defaultTarget: defaultTarget,
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

    // MARK: - Ask

    @ViewBuilder
    private var askSection: some View {
        if config != nil {
            AskSettingsSection(
                chat: binding(\.chat),
                agents: agents,
                connections: llmTargets,
                defaultTarget: defaultTarget
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
                .disabled(!model.maySaveSettings)
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
            TestResultRow(label: L("4 · Summarize"), result: result.summaryLlm)
            TestResultRow(label: L("5 · Judge"), result: result.judgeLlm)
            TestResultRow(label: L("6 · Translate"), result: result.translateLlm)
        }
        .knodeCard()
    }

    /// Title and one line of detail, nothing else: the "01 · …" eyebrow only
    /// repeated the tab selected in the strip above, and the badge beside it
    /// ("Configure once", "Per stage") restated the detail line — while
    /// looking like the status badges the rows use.
    private func sectionHeader(title: String, detail: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.title3.bold())
            Text(detail).font(.caption).foregroundStyle(.secondary)
        }
    }

    private func binding<Value>(_ keyPath: WritableKeyPath<KnodeConfig, Value>) -> Binding<Value> {
        Binding(
            get: { config![keyPath: keyPath] },
            set: { config![keyPath: keyPath] = $0 }
        )
    }

    private var embeddingSummary: RouteTarget {
        guard let config else { return RouteTarget(provider: L("Loading…")) }
        if let pool = config.embeddingPool, pool.enabled { return RouteTarget(provider: L("Embedding model pool"), model: pool.model) }
        guard let active = config.activeEmbedding else {
            return RouteTarget(provider: L("Embedding"), model: config.embedding.model.isEmpty ? L("API model not set") : config.embedding.model)
        }
        if active.provider == "local" { return RouteTarget(provider: active.label, model: L("%@d", String(active.dimensions))) }
        return RouteTarget(provider: active.label, model: active.model.isEmpty ? L("API model not set") : active.model)
    }

    private func routeSummary(_ keyPath: KeyPath<KnodeConfig, RoutedLLMConfig>) -> RouteTarget {
        guard let config, let route = config[keyPath: keyPath] as RoutedLLMConfig? else { return RouteTarget(provider: L("Loading…")) }
        // a stage names what it runs on; one naming nothing known runs on the default
        guard let target = routeTargets.first(where: { $0.id == route.use }) ?? defaultTarget else {
            return RouteTarget(provider: L("Not configured"))
        }
        // an inheriting model prints what it inherits, not a blank
        return RouteTarget(
            provider: target.label.isEmpty ? providerName(target.provider) : target.label,
            model: route.model.isEmpty ? target.model : route.model
        )
    }

    /// Everything the default can run on, against the on-screen draft: the
    /// models, then the CLI agents, called one-shot. The client mirror of the
    /// service's `llmTargets`; a model wins an id clash.
    private var llmTargets: [LLMConnection] {
        let connections = config?.connections ?? []
        return connections + agents.compactMap(\.asLlmTarget).filter { agent in !connections.contains { $0.id == agent.id } }
    }

    /// What the default is in the draft — a model, or a CLI agent — so
    /// pressing "Make default" shows its effect before a save.
    private var defaultTarget: LLMConnection? {
        llmTargets.first { $0.id == config?.llmUse } ?? llmTargets.first
    }

    /// Every agent a pipeline stage can call one-shot, against the on-screen
    /// draft: a CLI agent as itself, a deepagents agent as the model it runs
    /// on. Not `llmTargets`, because the default cannot be a deepagents agent
    /// — it may follow the default.
    private var routeAgents: [LLMConnection] {
        let connections = config?.connections ?? []
        return agents
            .compactMap { $0.asRouteTarget(connections: connections, defaultTarget: defaultTarget) }
            .filter { agent in !connections.contains { $0.id == agent.id } }
    }

    /// Everything a stage can name: the models, then the agents. The client
    /// mirror of the service's `routeTargets`; a model wins an id clash.
    private var routeTargets: [LLMConnection] {
        (config?.connections ?? []) + routeAgents
    }

    private func inheritedAgentSpecModel(_ spec: String) -> String {
        inheritedAgentModel(spec, agents: agents, targets: llmTargets, defaultTarget: defaultTarget)
    }

    /// Models the service reports for one route, using the on-screen draft so a
    /// key or endpoint typed but not yet saved is the one that gets queried.
    private func modelList(route: String, refresh: Bool = false) async throws -> ModelListResponse {
        guard let config else { throw APIError(message: L("Settings are still loading")) }
        return try await model.client().listModels(route: route, config: config, refresh: refresh)
    }

    /// Models for what a research or Ask spec names: an agent lists through
    /// its runtime, a model on its own route, and a bare CLI as a CLI.
    private func researchModelList(agent spec: String, refresh: Bool = false) async throws -> ModelListResponse {
        if let agent = agents.first(where: { $0.name == spec }) { return try await agentModelList(agent, refresh: refresh) }
        var bare = AgentDefinition(name: spec, executor: spec.isEmpty ? ResearchSettingsSection.defaultConnection : spec)
        // a bare CLI borrows the path of a CLI agent running it, as it runs
        bare.cliPath = llmTargets.first { $0.provider == spec }?.cliPath ?? ""
        return try await agentModelList(bare, refresh: refresh)
    }

    /// Models for one agent, from the on-screen draft: a deepagents agent's
    /// model lists on its own route; a CLI has no endpoint, so ask the default
    /// route with that CLI and its path swapped into a copy of the draft.
    private func agentModelList(_ agent: AgentDefinition, refresh: Bool = false) async throws -> ModelListResponse {
        guard let config else { throw APIError(message: L("Settings are still loading")) }
        if !agent.isCli {
            let id = agent.executor == ResearchSettingsSection.defaultConnection ? (defaultTarget?.id ?? "") : agent.executor
            if config.connections.contains(where: { $0.id == id }) {
                return try await model.client().listModels(route: "connection:\(id)", config: config, refresh: refresh)
            }
            return try await model.client().listModels(route: "llm", config: config, refresh: refresh)
        }
        var draft = config
        draft.llm.provider = agent.executor
        draft.llm.cliPath = agent.cliPath
        draft.llm.model = ""
        return try await model.client().listModels(route: "llm", config: draft, refresh: refresh)
    }

    /// The routes the five model stages name, in the order a document meets them.
    private let stageRoutes: [WritableKeyPath<KnodeConfig, RoutedLLMConfig>] = [
        \KnodeConfig.extraction.documentLlm,
        \KnodeConfig.extraction.entityLlm,
        \KnodeConfig.extraction.summaryLlm,
        \KnodeConfig.extraction.judgeLlm,
        \KnodeConfig.extraction.translateLlm,
    ]

    /// Every stage names what it runs on, and the service writes it down that
    /// way. A service from before that may still send '' or 'default' for
    /// "the default", which is `llmUse` — the picker has no entry for either.
    private func normalized(_ incoming: KnodeConfig) -> KnodeConfig {
        var config = incoming
        for keyPath in stageRoutes {
            let use = config[keyPath: keyPath].use
            if use.isEmpty || use == "default" { config[keyPath: keyPath].use = config.llmUse }
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
        // A stage on the deleted connection would fall back to the default
        // without saying so; move it there explicitly, by name.
        for keyPath in stageRoutes {
            if config![keyPath: keyPath].use == id { config![keyPath: keyPath].use = config!.llmUse }
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
            // an older service has no list to give, nor a stage to give it to
            if config?.languages != nil, let known = try? await model.client().languages().languages, !known.isEmpty {
                languageCatalog = known
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

/// The CLI executable is an override: the service resolves the command on its
/// own PATH first — which the desktop app augments with the usual install
/// directories — so the field only earns space when that lookup fails or the
/// user wants to pin one specific binary.
struct CliExecutableField: View {
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
    @Binding var expanded: Bool
    /// nil for a row that must not be removed — the last LLM connection, and
    /// the last embedding provider, since something has to answer and embed.
    let remove: (() -> Void)?
    /// nil when this row cannot be made the default: it already is, or its
    /// kind picks its default another way.
    var makeDefault: (() -> Void)? = nil
    /// What runs on this model, the way the agents table says who runs on an agent.
    var uses: [RowUse] = []
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

                // In a narrow window the name and the provider give way
                // first, down to a floor: the badges and buttons on this line
                // say what the row is and does, the provider text only
                // repeats the Kind.
                TextField(L("Name this provider"), text: $label)
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 150, maxWidth: 210)
                    .layoutPriority(1)

                Group {
                    if isDefault {
                        RouteBadge(label: L("Default"), color: color)
                    } else if let makeDefault {
                        Button(L("Make default"), action: makeDefault)
                            .buttonStyle(.link)
                            .font(.system(size: 10))
                            .help(L("Every job that names no provider of its own moves here"))
                    }
                }
                .lineLimit(1)
                .layoutPriority(1)

                Text(providerName)
                    .font(.callout)
                    .frame(minWidth: 90, maxWidth: 170, alignment: .leading)
                    .lineLimit(1)

                // one line is the point of a table row; the untruncated value
                // is a hover away rather than a second line per provider
                Text(summary.isEmpty ? L("No model set") : summary)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(summary.isEmpty ? .tertiary : .secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(summary)

                Spacer(minLength: 8)

                RowUseBadges(uses: uses)

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
/// An LLM row is a model endpoint: where it is, its key, and which model. The
/// coding-agent CLIs that used to be picked here are agents now, in the table
/// below, with their path and effort.
private struct LlmProviderFields: View {
    @Binding var model: String
    @Binding var baseUrl: String
    @Binding var apiKey: String
    let route: String
    let load: (Bool) async throws -> ModelListResponse

    var body: some View {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
            GridRow {
                FieldLabel(L("Base URL")) { TextField("https://api.openai.com/v1", text: $baseUrl) }
                FieldLabel(L("API key")) { SecureField("env:OPENAI_API_KEY", text: $apiKey) }
            }
            GridRow {
                ModelField(
                    placeholder: "gpt-4.1-mini",
                    text: $model,
                    providerKey: baseUrl,
                    route: route,
                    load: load
                )
                .gridCellColumns(2)
            }
            GridRow {
                Text(L("Any OpenAI-compatible chat endpoint works (OpenAI, DeepSeek, Ollama, vLLM, SiliconFlow…). Use env:VAR_NAME to keep the key out of the config file. An empty model disables LLM features; the deterministic pipeline keeps running."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .gridCellColumns(2)
            }
        }
    }
}

/**
 * The model an agent spec runs with when it names none of its own, shown as a
 * Model field's placeholder and never written. The spec may be an agent
 * *name* — and a name can legitimately be `default`, so the name is looked up
 * first. The client-side mirror of the service's `resolveAgentSpec`.
 *
 * A CLI agent carries its own model and inherits nothing; a deepagents agent
 * takes the model of the endpoint it runs on — the default only while the
 * default is a model. A bare spec is resolved against `targets` (models and
 * CLI agents): a bare CLI borrows the model of a CLI agent running it, the
 * default's first.
 */
@MainActor
func inheritedAgentModel(_ spec: String, agents: [AgentDefinition], targets: [LLMConnection], defaultTarget: LLMConnection?) -> String {
    let wanted = spec.trimmingCharacters(in: .whitespaces)
    if let agent = agents.first(where: { $0.name == wanted }) {
        if !agent.model.isEmpty || agent.isCli { return agent.model }
        if agent.executor == ResearchSettingsSection.defaultConnection {
            return defaultTarget?.provider == "openai" ? defaultTarget?.model ?? "" : ""
        }
        return targets.first { $0.id == agent.executor && $0.provider == "openai" }?.model ?? ""
    }
    if wanted == ResearchSettingsSection.defaultConnection { return defaultTarget?.model ?? "" }
    if let target = targets.first(where: { $0.id == wanted }) { return target.model }
    guard cliProviderNames.contains(wanted) else { return "" }
    return (defaultTarget?.provider == wanted ? defaultTarget : targets.first { $0.provider == wanted })?.model ?? ""
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
            // a text field fills the width either way; a pop-up keeps its
            // own, and centred it floated away from the caption above it
            content
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Picks what runs a stage — a model called directly, or an agent run once
/// through its own loop — plus an optional model override. The menu groups
/// them under LLM and Agent, so each entry is just its name.
///
/// A stage names exactly one of them. There used to be a "Default LLM
/// provider · X" entry as well, which sat beside X's own row: two entries for
/// one endpoint, which only came apart when the default later moved.
private struct StagePicker: View {
    @Binding var route: RoutedLLMConfig
    let models: [LLMConnection]
    /// Every agent a stage can run (see `routeAgents`).
    let agents: [LLMConnection]
    /// Where a stage that names nothing known runs, as the service resolves it.
    let defaultTarget: LLMConnection?
    let routeKey: String
    let load: (Bool) async throws -> ModelListResponse

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            FieldLabel(L("Run with")) {
                Picker(L("Run with"), selection: selection) {
                    Section(L("LLM")) {
                        ForEach(models) { connection in
                            Text(name(connection)).tag(connection.id)
                        }
                    }
                    if !agents.isEmpty {
                        Section(L("Agent")) {
                            ForEach(agents) { agent in
                                Text(name(agent)).tag(agent.id)
                            }
                        }
                    }
                }
                .labelsHidden()
            }
            ModelField(
                placeholder: L("Optional · use its model"),
                text: $route.model,
                inherited: target?.model ?? "",
                providerKey: target?.id ?? route.use,
                route: routeKey,
                load: load,
                tuning: tuning
            )
            Text(runningOn)
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What the stage runs on: what it names, or — naming nothing known, as
    /// a stage on a just-removed agent does — the default, which is where the
    /// service runs it and what a save writes down.
    private var target: LLMConnection? {
        (models + agents).first { $0.id == route.use } ?? defaultTarget
    }

    /// Shows `target`, so a stage naming nothing known reads as where it runs
    /// rather than as a blank; picking writes the id.
    private var selection: Binding<String> {
        Binding(get: { target?.id ?? route.use }, set: { route.use = $0 })
    }

    private func name(_ connection: LLMConnection) -> String {
        connection.label.isEmpty ? providerName(connection.provider) : connection.label
    }

    /// A stage on a CLI agent sets its own effort and speed; "default" is the
    /// agent's, as the service's `resolveRoutedLlmConfig` reads it. An API
    /// model takes neither.
    private var tuning: ModelTuning? {
        guard let target, cliProviderNames.contains(target.provider) else { return nil }
        return ModelTuning(
            effort: $route.effort,
            speed: $route.speed,
            runtime: target.provider,
            inheritedEffort: target.effort,
            inheritedSpeed: target.speed,
            inheritedFrom: L("the agent")
        )
    }

    private var runningOn: String {
        guard let connection = target else {
            return L("Nothing to run on yet — add a model under Providers & Agents.")
        }
        guard connection.provider == "openai" else {
            // a CLI agent spends its own login, as its row under Providers & Agents says
            return L("Runs on your %@ subscription.", cliProductName(connection.provider) ?? providerName(connection.provider))
        }
        let endpoint = connection.baseUrl.isEmpty ? L("no endpoint set") : connection.baseUrl
        // a deepagents agent is its endpoint's model, reached through the loop
        if agents.contains(where: { $0.id == connection.id }) {
            return L("Runs the deepagents loop on %@.", endpoint)
        }
        return L("Runs on %@.", endpoint)
    }
}

/**
 * Where a stage runs, as the two things a person reads separately: who runs
 * it, and which model. They used to share one middle-truncated line, which
 * turned "super-relay · ark/seed-evolving" into "super-relay…ed-evolving" —
 * both ends of both facts lost at once.
 *
 * `line` is the joined form, for the places that still want one string.
 */
struct RouteTarget {
    var provider: String
    var model: String = ""

    var line: String { model.isEmpty ? provider : "\(provider) · \(model)" }
}

/**
 * What runs on a row of the models or agents table — pipeline stages,
 * agents, Research, Ask — as one badge each at the row's right end, the
 * specifics on hover. Both tables put them in the same place, so a row that
 * nothing runs on reads as idle at a glance.
 */
struct RowUse: Identifiable, Equatable {
    let label: String
    let color: Color
    var help: String = ""

    var id: String { label }
}

struct RowUseBadges: View {
    let uses: [RowUse]

    var body: some View {
        HStack(spacing: 6) {
            ForEach(uses) { use in
                RouteBadge(label: use.label, color: use.color)
                    .lineLimit(1)
                    .help(use.help)
            }
        }
        // a narrow window truncates the model id, which is a hover away,
        // before it squeezes these; at the minimum they cut off rather than
        // stack their letters vertically
        .layoutPriority(1)
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

/// The six stages, in the order a document meets them. Declaring them once
/// keeps the flow nodes, the inspector and the per-stage rates from drifting
/// apart — they used to be five hand-written blocks.
///
/// The first four are per document: Convert and Index on sync, Extract and
/// Summarize in the background pass. Judge decides things — duplicates after
/// each pass, disputes and Dream at night, knode_ask on demand. Translate is
/// per document again, on slots of its own (docs/design/17); it came last and
/// stays last, so the others keep the numbers both clients show. Concept pages
/// are research's job, not a stage's (docs/design/09).
enum PipelineStage: Int, CaseIterable, Identifiable {
    case convert = 1, index, extract, summarize, judge, translate

    var id: Int { rawValue }
    var step: Int { rawValue }

    @MainActor var title: String {
        switch self {
        case .convert: L("Convert")
        case .index: L("Index")
        case .extract: L("Extract")
        case .summarize: L("Summarize")
        case .judge: L("Judge")
        case .translate: L("Translate")
        }
    }

    @MainActor var requirement: String {
        switch self {
        case .convert: L("Vision")
        case .index: L("Embedding")
        case .extract: L("Volume")
        case .summarize: L("Prose")
        case .judge: L("Quality")
        case .translate: L("Languages")
        }
    }

    /// Cyan is the index and its embeddings; violet is everything an LLM runs.
    var color: Color { self == .index ? .knodeCyan : .knodeViolet }

    @MainActor var detail: String {
        switch self {
        case .convert: L("Images and scanned PDF pages become searchable Markdown.")
        case .index: L("Every chunk becomes a vector for semantic and hybrid recall.")
        case .extract: L("Names entities, relations and factual claims in changed documents, a long one in segments; what it finds is checked for duplicates right away.")
        case .summarize: L("Writes one summary page per document, right after it is extracted.")
        case .judge: L("Answers knode_ask and reviews duplicate entities and claims after each extraction pass; overnight it runs Dream and reviews disputed claims.")
        case .translate: L("Translates documents into the workspace's languages, a segment at a time, and keeps each translation beside its original.")
        }
    }

    @MainActor var requirementDetail: String {
        switch self {
        case .convert:
            L("The model has to see pixels: an API provider gets the image inline, codex takes --image, and claude and cursor read the file with their own tools. A text-only model fails here. Changing this re-converts every image and scanned page.")
        case .index:
            L("Not an LLM — it uses one of the embedding models under Providers & Agents. Changing which one, or its model or dimensions, re-embeds the whole corpus.")
        case .extract:
            L("The busiest stage — it runs on every changed document, a long one in segments, bounded by the calls per pass here. A fast, cheap model that returns clean JSON is usually the right trade.")
        case .summarize:
            L("One call per document, for people to read rather than a program to parse, so it wants clean prose more than the strongest model. Changing the model does not rewrite summaries already written.")
        case .judge:
            L("Few calls, but each one decides something — whether two entities are one, whether two claims say the same, which of two claims holds, what a week of agent sessions says — so a stronger model pays for itself. Only knode_ask has someone waiting on the answer.")
        case .translate:
            L("One call per segment of about 8,000 characters, or 4,000 of Chinese, Japanese or Korean. It is for people to read, so it wants a model that writes both languages well and leaves every link, anchor and piece of code where it was; an answer that loses one is tried again. Changing the model does not rewrite translations already written.")
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

/// A CLI runtime by its product's name — "Codex", not "Codex CLI" — for
/// saying whose subscription a CLI agent spends. Nil for anything else.
func cliProductName(_ executor: String) -> String? {
    switch executor {
    case "claude-cli": "Claude Code"
    case "codex-cli": "Codex"
    case "cursor-cli": "Cursor"
    default: nil
    }
}
