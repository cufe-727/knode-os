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
                    pipelineSummary
                    providersSection
                    pipelineSection
                    researchSection
                    if let testResult { testResults(testResult) }
                    if !statusMessage.isEmpty {
                        Label(statusMessage, systemImage: statusIsError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                            .font(.callout)
                            .foregroundStyle(statusIsError ? Color.knodeBad : Color.knodeGood)
                            .knodeCard()
                    }
                    workspaceDangerSection
                } else {
                    EmptyState(symbol: "slider.horizontal.3", title: L("Could not load settings"), message: L("The local service is unavailable. Retry to start it and reload this workspace's routes."), actionTitle: L("Retry"), action: { Task { await retry() } })
                }
            }
            .padding(28)
            .frame(maxWidth: 1040)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
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

    /// The pipeline at a glance, in the order a document actually moves through it.
    private var pipelineSummary: some View {
        HStack(spacing: 0) {
            SummaryRoute(label: L("Convert"), value: routeSummary(\.extraction.documentLlm), detail: L("Images & scanned PDFs"), color: .knodeViolet)
            Divider().frame(height: 54)
            SummaryRoute(label: L("Index"), value: embeddingSummary, detail: L("Embedding"), color: .knodeCyan)
            Divider().frame(height: 54)
            SummaryRoute(label: L("Extract"), value: routeSummary(\.extraction.entityLlm), detail: L("Entities & relations"), color: .knodeViolet)
            Divider().frame(height: 54)
            SummaryRoute(label: L("Synthesize"), value: routeSummary(\.extraction.conceptLlm), detail: L("Concept pages"), color: .knodeViolet)
            Divider().frame(height: 54)
            SummaryRoute(label: L("Answer"), value: defaultModelSummary, detail: L("Ask, Wiki & Dream"), color: .knodeViolet)
        }
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08)) }
    }

    // MARK: - 01 · Providers

    /// Every endpoint and credential lives here, once. Section 02 only points at them.
    private var providersSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                index: L("01 · Providers"),
                title: L("Endpoints and credentials"),
                detail: L("Configure each provider once. Every stage below picks from this list, so no endpoint or key is ever entered twice."),
                badge: L("Configure once"),
                color: .knodeCyan
            )
            embeddingCard
            defaultProviderCard
            connectionsEditor
        }
    }

    private var embeddingCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            cardHeader(
                title: L("Embedding provider"),
                detail: L("One per workspace — the Index stage always uses it."),
                badge: L("Required"),
                color: .knodeCyan
            )
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Provider")) {
                        Picker(L("Provider"), selection: binding(\.embedding.provider)) {
                            Text(L("Local hashing · offline")).tag("local")
                            Text(L("OpenAI-compatible API")).tag("openai")
                            Text(L("Volcengine Ark · multimodal")).tag("ark-multimodal")
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: config?.embedding.provider == "ark-multimodal" ? "ep-…" : "text-embedding-3-small",
                        text: binding(\.embedding.model),
                        providerKey: config?.embedding.provider ?? "",
                        disabled: config?.embedding.provider == "local",
                        load: { try await modelList(route: "embedding") }
                    )
                }
                GridRow {
                    FieldLabel(L("Base URL")) {
                        TextField("https://api.openai.com/v1", text: binding(\.embedding.baseUrl))
                            .disabled(config?.embedding.provider == "local")
                    }
                    FieldLabel(L("API key")) {
                        SecureField("env:OPENAI_API_KEY", text: binding(\.embedding.apiKey))
                            .disabled(config?.embedding.provider == "local")
                    }
                }
                GridRow {
                    FieldLabel(L("Dimensions")) {
                        TextField(L("Dimensions"), value: binding(\.embedding.dimensions), format: .number)
                    }
                    Toggle(L("Send dimensions with API requests"), isOn: binding(\.embedding.sendDimensions))
                        .toggleStyle(.checkbox)
                        .disabled(config?.embedding.provider == "local")
                }
            }
            Text(embeddingNote)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .knodeCard(padding: 18)
    }

    private var defaultProviderCard: some View {
        VStack(alignment: .leading, spacing: 14) {
            cardHeader(
                title: L("Default LLM provider"),
                detail: L("What a stage runs on unless it picks another connection, and what answers Ask, Wiki and Dream."),
                badge: L("Default"),
                color: .knodeViolet
            )
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Provider")) {
                        Picker(L("Provider"), selection: binding(\.llm.provider)) {
                            Text(L("OpenAI-compatible API")).tag("openai")
                            Text(L("Codex CLI")).tag("codex-cli")
                            Text(L("Claude Code CLI")).tag("claude-cli")
                            Text(L("Cursor Agent CLI")).tag("cursor-cli")
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: config?.llm.provider == "openai" ? "gpt-4.1-mini" : "Use CLI default",
                        text: binding(\.llm.model),
                        providerKey: config?.llm.provider ?? "",
                        load: { try await modelList(route: "llm") }
                    )
                }
                if config?.llm.provider == "openai" {
                    GridRow {
                        FieldLabel(L("Base URL")) { TextField("https://api.openai.com/v1", text: binding(\.llm.baseUrl)) }
                        FieldLabel(L("API key")) { SecureField("env:OPENAI_API_KEY", text: binding(\.llm.apiKey)) }
                    }
                } else {
                    GridRow {
                        CliExecutableField(tool: cliTools[config?.llm.provider ?? ""], path: binding(\.llm.cliPath))
                            .gridCellColumns(2)
                    }
                }
            }
            Text(defaultModelNote)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .knodeCard(padding: 18)
    }

    /// Extra endpoints beyond the default, named so a stage can pick one by name.
    private var connectionsEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Other connections")).font(.headline)
                    Text(L("Add one when a stage needs a different endpoint — a vision-capable API, a cheaper model, a second key."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Add connection", systemImage: "plus") { addConnection() }
                    .buttonStyle(.bordered)
                    .disabled(config == nil)
            }
            ForEach(Array((config?.connections ?? []).enumerated()), id: \.element.id) { index, connection in
                ConnectionCard(
                    connection: binding(\.connections)[index],
                    cliTools: cliTools,
                    load: { try await modelList(route: "connection:\(connection.id)") },
                    remove: { removeConnection(id: connection.id) }
                )
            }
        }
    }

    // MARK: - 02 · Pipeline

    /// The stages in the order a document passes through them, each with what it
    /// asks of a model and a picker over section 01.
    private var pipelineSection: some View {
        VStack(alignment: .leading, spacing: 14) {
            sectionHeader(
                index: L("02 · Pipeline"),
                title: L("What each stage needs"),
                detail: L("A document moves down this list. The stages ask different things of a model, which is why each one can run somewhere else."),
                badge: L("Per stage"),
                color: .knodeViolet
            )
            VStack(spacing: 0) {
                StageRow(
                    step: 1,
                    title: L("Convert"),
                    detail: L("Images and scanned PDF pages become searchable Markdown."),
                    requirement: L("Vision"),
                    requirementDetail: L("The model has to see pixels: an API provider gets the image inline, codex takes --image, and claude and cursor read the file with their own tools. A text-only model fails here. Changing this re-converts every image and scanned page."),
                    color: .knodeViolet
                ) {
                    StagePicker(
                        route: binding(\.extraction.documentLlm),
                        connections: config?.connections ?? [],
                        defaultProvider: config?.llm.provider ?? "",
                        load: { try await modelList(route: "documentLlm") }
                    )
                }
                Divider()
                StageRow(
                    step: 2,
                    title: L("Index"),
                    detail: L("Every chunk becomes a vector for semantic and hybrid recall."),
                    requirement: L("Embedding"),
                    requirementDetail: L("Not an LLM — it uses the embedding provider from section 01, one per workspace. Changing its model or dimensions re-embeds the whole corpus."),
                    color: .knodeCyan
                ) {
                    StagePin(value: embeddingSummary, hint: L("Set in section 01 · Embedding provider"))
                }
                Divider()
                StageRow(
                    step: 3,
                    title: L("Extract"),
                    detail: L("Names entities, relations and factual claims in changed documents."),
                    requirement: L("Volume"),
                    requirementDetail: L("The busiest stage — it runs on every changed document, bounded by the daily budget and batch size below. A fast, cheap model that returns clean JSON is usually the right trade."),
                    color: .knodeViolet
                ) {
                    StagePicker(
                        route: binding(\.extraction.entityLlm),
                        connections: config?.connections ?? [],
                        defaultProvider: config?.llm.provider ?? "",
                        load: { try await modelList(route: "entityLlm") }
                    )
                }
                Divider()
                StageRow(
                    step: 4,
                    title: L("Synthesize"),
                    detail: L("Turns hot entity clusters into readable, linked Concept pages."),
                    requirement: L("Quality"),
                    requirementDetail: L("Far fewer calls than Extract — only hot clusters reach it — and the output is prose people read, so a stronger model pays for itself here."),
                    color: .knodeViolet
                ) {
                    StagePicker(
                        route: binding(\.extraction.conceptLlm),
                        connections: config?.connections ?? [],
                        defaultProvider: config?.llm.provider ?? "",
                        load: { try await modelList(route: "conceptLlm") }
                    )
                }
                Divider()
                StageRow(
                    step: 5,
                    title: L("Answer"),
                    detail: L("Ask, wiki summaries and the nightly Dream analysis."),
                    requirement: L("Interactive"),
                    requirementDetail: L("Always the default provider. Latency lands straight in the Ask box, so prefer something responsive."),
                    color: .knodeViolet
                ) {
                    StagePin(value: defaultModelSummary, hint: L("Set in section 01 · Default LLM provider"))
                }
            }
            .knodeCard(padding: 0)
            pipelineControls
        }
    }

    private var pipelineControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Pipeline controls")).font(.headline)
                Text(L("Bound background work without changing the selected models."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 10) {
                GridRow {
                    FieldLabel(L("Daily token budget")) {
                        TextField(L("Budget"), value: binding(\.extraction.dailyTokenBudget), format: .number)
                    }
                    FieldLabel(L("Documents per pass")) {
                        TextField(L("Batch"), value: binding(\.extraction.batchSize), format: .number)
                    }
                    FieldLabel(L("Parallel calls")) {
                        TextField(L("Concurrency"), value: binding(\.extraction.concurrency), format: .number)
                    }
                }
            }
            Toggle(L("Extract factual claims alongside entities"), isOn: binding(\.extraction.claims))
                .toggleStyle(.checkbox)
        }
        .knodeCard(padding: 18)
    }

    // MARK: - 03 · Deep research

    /// The research runner and the profile it follows. Both live in files the
    /// service owns — the runner in the workspace config, the profile in
    /// `playbooks/research/profiles/` — so "Save & apply" writes both.
    @ViewBuilder
    private var researchSection: some View {
        if config != nil {
            ResearchSettingsSection(
                research: binding(\.research),
                profile: $profileDraft,
                dirty: $profileDirty,
                profileSelection: researchProfileBinding,
                summaries: profiles,
                connections: config?.connections ?? [],
                defaultProvider: config?.llm.provider ?? "",
                isWorking: isWorking,
                loadModels: { agent in try await researchModelList(agent: agent) },
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

    private func cardHeader(title: String, detail: String, badge: String, color: Color) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            RouteBadge(label: badge, color: color)
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

    private var embeddingNote: String {
        switch config?.embedding.provider {
        case "local":
            return L("The local hashing embedder is private, offline, and ready immediately.")
        case "ark-multimodal":
            return L("Ark posts to /embeddings/multimodal and returns one vector per request, so Base URL ends at /api/v3 and Model is the endpoint id (ep-…). Dimensions must match the model — doubao-embedding-vision is 2048, or 1024 when the dimensions parameter is sent.")
        default:
            return L("Changing the API model or dimensions re-embeds the corpus after saving. Use env:VAR_NAME to keep keys out of the config file.")
        }
    }

    private var embeddingSummary: String {
        guard let config else { return L("Loading…") }
        return config.embedding.provider == "local"
            ? L("Local hashing · %@d", String(config.embedding.dimensions))
            : (config.embedding.model.isEmpty ? L("API model not set") : config.embedding.model)
    }

    private func routeSummary(_ keyPath: KeyPath<KnodeConfig, RoutedLLMConfig>) -> String {
        guard let config, let route = config[keyPath: keyPath] as RoutedLLMConfig? else { return L("Loading…") }
        let connection = config.connections.first { $0.id == route.use }
        let name = connection?.label ?? (route.use.isEmpty ? L("Default model") : providerName(route.provider))
        let model = route.model.isEmpty ? (connection?.model ?? "") : route.model
        return model.isEmpty ? name : "\(name) · \(model)"
    }

    private var defaultModelSummary: String {
        guard let config else { return L("Not configured") }
        return config.llm.model.isEmpty ? providerName(config.llm.provider) : "\(providerName(config.llm.provider)) · \(config.llm.model)"
    }

    private var defaultModelNote: String {
        guard let provider = config?.llm.provider else { return "" }
        return switch provider {
        case "codex-cli": L("Uses your existing Codex login for a read-only one-shot request.")
        case "claude-cli": L("Uses your existing Claude Code login for one non-interactive turn.")
        case "cursor-cli": L("Uses your existing Cursor Agent login in headless print mode.")
        default: L("Any OpenAI-compatible chat endpoint works (OpenAI, DeepSeek, Ollama, vLLM, SiliconFlow…). Use env:VAR_NAME to keep the key out of the config file. An empty model disables LLM features; the deterministic pipeline keeps running.")
        }
    }

    /// Models the service reports for one route, using the on-screen draft so a
    /// key or endpoint typed but not yet saved is the one that gets queried.
    private func modelList(route: String) async throws -> ModelListResponse {
        guard let config else { throw APIError(message: L("Settings are still loading")) }
        return try await model.client().listModels(route: route, config: config)
    }

    /// Models for a research agent. A named connection lists on its own route;
    /// a CLI picked straight off PATH has no connection, so ask the default
    /// route with that provider swapped into a copy of the draft.
    private func researchModelList(agent: String) async throws -> ModelListResponse {
        guard let config else { throw APIError(message: L("Settings are still loading")) }
        if !agent.isEmpty, config.connections.contains(where: { $0.id == agent }) {
            return try await model.client().listModels(route: "connection:\(agent)", config: config)
        }
        var draft = config
        if !agent.isEmpty {
            draft.llm.provider = agent
            draft.llm.cliPath = ""
            draft.llm.model = ""
        }
        return try await model.client().listModels(route: "llm", config: draft)
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
        config!.connections.append(LLMConnection(id: "connection-\(suffix)", label: "Connection \(suffix)"))
    }

    private func removeConnection(id: String) {
        guard config != nil else { return }
        config!.connections.removeAll { $0.id == id }
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
    /// Changing provider invalidates a fetched list, since it came from the old one.
    var providerKey: String = ""
    var disabled = false
    let load: () async throws -> ModelListResponse

    @State private var isShowing = false
    @State private var isLoading = false
    @State private var result: ModelListResponse?
    @State private var failure: String?
    @State private var filter = ""

    var body: some View {
        FieldLabel(L("Model")) {
            HStack(spacing: 6) {
                TextField(placeholder, text: $text)
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
            .onChange(of: providerKey) { _, _ in
                result = nil
                failure = nil
                filter = ""
            }
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
            if let note = result?.note {
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Divider()
            HStack {
                Text(L("Picking one fills the field — Save & apply writes it to the workspace config."))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
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
        if isLoading || (result != nil && !force) { return }
        isLoading = true
        failure = nil
        defer { isLoading = false }
        do {
            result = try await load()
        } catch {
            failure = error.localizedDescription
        }
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
            Label("\(tool.command) is not on the service PATH — enter its full path.", systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(Color.knodeBad)
                .fixedSize(horizontal: false, vertical: true)
        } else if !path.isEmpty || editing {
            Button("Use \(tool.command) from PATH instead") {
                path = ""
                editing = false
            }
            .buttonStyle(.link)
            .font(.caption)
        }
    }
}

/// One named connection: the endpoint and credentials a route points at by id.
private struct ConnectionCard: View {
    @Binding var connection: LLMConnection
    let cliTools: [String: CliTool]
    let load: () async throws -> ModelListResponse
    let remove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                TextField(L("Name this connection"), text: $connection.label)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 240)
                Text(connection.id)
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(.tertiary)
                Spacer()
                Button(role: .destructive) { remove() } label: { Image(systemName: "trash") }
                    .buttonStyle(.borderless)
                    .help(L("Remove this connection"))
            }
            Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 12) {
                GridRow {
                    FieldLabel(L("Provider")) {
                        Picker(L("Provider"), selection: $connection.provider) {
                            Text(L("OpenAI-compatible API")).tag("openai")
                            Text(L("Codex CLI")).tag("codex-cli")
                            Text(L("Claude Code CLI")).tag("claude-cli")
                            Text(L("Cursor Agent CLI")).tag("cursor-cli")
                        }
                        .labelsHidden()
                    }
                    ModelField(
                        placeholder: connection.provider == "openai" ? "gpt-4.1-mini" : "Use CLI default",
                        text: $connection.model,
                        providerKey: connection.provider,
                        load: load
                    )
                }
                if connection.provider == "openai" {
                    GridRow {
                        FieldLabel(L("Base URL")) { TextField("https://api.openai.com/v1", text: $connection.baseUrl) }
                        FieldLabel(L("API key")) { SecureField("env:OPENAI_API_KEY", text: $connection.apiKey) }
                    }
                } else {
                    GridRow {
                        CliExecutableField(tool: cliTools[connection.provider], path: $connection.cliPath)
                            .gridCellColumns(2)
                    }
                }
            }
        }
        .knodeCard(padding: 18)
    }
}

private struct SummaryRoute: View {
    let label: String
    let value: String
    let detail: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Eyebrow(text: label, color: color)
            Text(value).font(.callout.weight(.semibold)).lineLimit(1)
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
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
            content
                .textFieldStyle(.roundedBorder)
                .frame(maxWidth: .infinity)
        }
    }
}

/// One pipeline stage: what it does, what it asks of a model, and the control
/// that points it at a provider from section 01.
private struct StageRow<Control: View>: View {
    let step: Int
    let title: String
    let detail: String
    let requirement: String
    let requirementDetail: String
    let color: Color
    @ViewBuilder let control: Control

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Text("\(step)")
                .font(.caption.monospaced().bold())
                .foregroundStyle(color)
                .frame(width: 26, height: 26)
                .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
                .overlay { RoundedRectangle(cornerRadius: 7).stroke(color.opacity(0.28)) }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    Text(title).font(.headline)
                    RouteBadge(label: requirement, color: color)
                }
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(requirementDetail)
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 16)
            control.frame(width: 300)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Picks which configured provider runs a stage, plus an optional model override.
private struct StagePicker: View {
    @Binding var route: RoutedLLMConfig
    let connections: [LLMConnection]
    let defaultProvider: String
    let load: () async throws -> ModelListResponse

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
                providerKey: route.use,
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
            return "Runs on the default provider (\(providerName(defaultProvider)))."
        }
        let endpoint = connection.provider == "openai"
            ? (connection.baseUrl.isEmpty ? "no endpoint set" : connection.baseUrl)
            : providerName(connection.provider)
        return "Runs on \(endpoint)."
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
