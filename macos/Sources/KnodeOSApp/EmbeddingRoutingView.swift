import SwiftUI

func canonicalEmbeddingModel(_ name: String) -> String {
    ["bge-m3", "baai/bge-m3", "@cf/baai/bge-m3"].contains(name.lowercased()) ? "bge-m3" : name
}

func embeddingMatchesPool(_ entry: EmbeddingConnection, _ pool: EmbeddingPoolConfig) -> Bool {
    guard entry.enabled != false, entry.provider == "openai" else { return false }
    let canonical = canonicalEmbeddingModel(pool.model)
    let hasModel = ([entry.model] + (entry.catalog ?? [])).contains { canonicalEmbeddingModel($0) == canonical }
    return hasModel && (canonical == "bge-m3" ? pool.dimensions == 1024 : entry.model == pool.model && entry.dimensions == pool.dimensions)
}

/// Model choice belongs to the workspace; account budgets survive workspace changes.
struct EmbeddingRoutingSection: View {
    @EnvironmentObject private var app: AppModel
    @Binding var config: KnodeConfig?
    @State private var usage: [EmbeddingUsage] = []
    @State private var status = ""
    @State private var working = false
    @State private var showUsage = false

    private var pool: Binding<EmbeddingPoolConfig> {
        Binding(get: { config?.embeddingPool ?? EmbeddingPoolConfig() }, set: { config?.embeddingPool = $0 })
    }
    private var entries: [EmbeddingConnection] { config?.embeddingProviders ?? [] }
    private var members: [EmbeddingConnection] { entries.filter { embeddingMatchesPool($0, pool.wrappedValue) } }
    private var models: [String] {
        Array(Set(entries.flatMap { [$0.model] + ($0.catalog ?? []) }.filter { !$0.isEmpty }.map(canonicalEmbeddingModel))).sorted()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Label(L("Embedding model pool"), systemImage: "arrow.triangle.branch")
                    .font(.headline).foregroundStyle(Color.knodeCyan)
                Spacer()
                Toggle(L("Automatic routing"), isOn: pool.enabled).toggleStyle(.switch)
            }
            Text(L("Choose one model. Compatible keys share the work; lower priorities run first, equal priorities rotate. Rate-limited or unavailable keys cool down automatically."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Pool model")).font(.caption).foregroundStyle(.secondary)
                    HStack {
                        TextField("bge-m3", text: pool.model)
                        Menu {
                            ForEach(models, id: \.self) { name in
                                Button(name) {
                                    pool.wrappedValue.model = name
                                    if name == "bge-m3" { pool.wrappedValue.dimensions = 1024 }
                                }
                            }
                        } label: { Image(systemName: "chevron.down") }.menuStyle(.borderlessButton).fixedSize()
                    }
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Dimensions")).font(.caption).foregroundStyle(.secondary)
                    TextField("1024", value: pool.dimensions, format: .number)
                }.frame(width: 95)
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Texts per request")).font(.caption).foregroundStyle(.secondary)
                    TextField("16", value: pool.batchSize, format: .number)
                }.frame(width: 115)
            }
            .disabled(!pool.wrappedValue.enabled)
            HStack {
                Text(L("%@ compatible keys · %@ configured", String(members.count), String(entries.count)))
                    .font(.system(.caption, design: .monospaced))
                    .foregroundStyle(members.isEmpty && pool.wrappedValue.enabled ? Color.orange : Color.secondary)
                Spacer()
                Button(L("Refresh all models")) { Task { await refreshModels() } }
                Button(L("Test pool")) { Task { await test() } }.disabled(!pool.wrappedValue.enabled)
                Button(L("Refresh usage")) { Task { await refreshUsage() } }
            }.disabled(working)
            if !status.isEmpty { Text(status).font(.caption).textSelection(.enabled) }
            Text(L("Pool vectors are L2-normalized. Only matching models and dimensions participate. Changing the pool model re-embeds the workspace; changing keys or limits does not."))
                .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            DisclosureGroup(L("Usage today · shared across workspaces"), isExpanded: $showUsage) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(entries.filter { $0.provider == "openai" }) { entry in
                        usageRow(entry)
                    }
                    Text(L("App usage persists across restarts. Tokens are the provider's own count when its response includes one (SiliconFlow, OpenRouter), otherwise an estimate for the model (Cloudflare reports none). Activity in other apps is not included. Zero limits block requests."))
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }.padding(.top, 8)
            }.font(.caption)
        }
        .padding(18)
        .background(Color.knodeCyan.opacity(0.045), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.knodeCyan.opacity(0.2)))
        .task { await refreshUsage() }
    }

    private func usageRow(_ entry: EmbeddingConnection) -> some View {
        let row = usage.first { $0.id == entry.id }
        let limits = entry.limits ?? EmbeddingLimits()
        let cooling = (row?.cooldownUntil ?? 0) > Date().timeIntervalSince1970 * 1000
        return HStack(spacing: 12) {
            Circle().fill(entry.enabled == false ? Color.gray : cooling ? Color.orange : Color.knodeCyan).frame(width: 6, height: 6)
            Text(entry.label).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
            Text("\(row?.requestsToday ?? 0) / \(limits.requestsPerDay) req")
            Text("\(row?.tokensToday ?? 0) / \(limits.tokensPerDay) tokens\(tokenSource(row))")
            Text(cooling ? L("Cooling down") : limits.resetTimezone).foregroundStyle(.secondary)
        }.font(.system(size: 10, design: .monospaced)).help(row?.lastError ?? entry.limitNote ?? "")
    }

    /// Which of today's tokens a provider counted. A day recorded before the split existed has none, so no tag.
    private func tokenSource(_ row: EmbeddingUsage?) -> String {
        guard let row, row.tokensToday > 0, var estimated = row.estimatedTokensToday else { return "" }
        estimated = min(estimated, row.tokensToday)
        if estimated == 0 { return " · " + L("reported") }
        if estimated == row.tokensToday { return " · " + L("estimated") }
        return " · " + L("%d%% estimated", 100 * estimated / row.tokensToday)
    }

    private func refreshUsage() async {
        do { usage = try await app.client().embeddingUsage().entries }
        catch { status = error.localizedDescription }
    }

    private func refreshModels() async {
        guard let draft = config else { return }
        working = true
        defer { working = false }
        var successes = 0
        var failures: [String] = []
        for entry in draft.embeddingProviders where entry.provider == "openai" {
            status = L("Loading models: %@", entry.label)
            do {
                let result = try await app.client().listModels(route: "embedding:\(entry.id)", config: draft, refresh: true)
                if result.ok, let index = config?.embeddingProviders.firstIndex(where: { $0.id == entry.id }) {
                    config?.embeddingProviders[index].catalog = result.models.map(\.id)
                    successes += 1
                } else { failures.append(entry.label) }
            } catch { failures.append(entry.label) }
        }
        status = L("Refreshed %@ keys. Save & apply to keep the catalog.", String(successes))
        if !failures.isEmpty { status += " · " + L("Unavailable") + ": " + failures.joined(separator: ", ") }
    }

    private func test() async {
        guard let draft = config else { return }
        working = true
        defer { working = false }
        do {
            let response = try await app.client().testEmbedding(draft)
            status = response.ok ? L("Pool test passed · %@ dimensions · %@ ms", String(response.dimensions ?? 0), String(response.ms ?? 0)) : response.error ?? L("Unavailable")
        } catch { status = error.localizedDescription }
        await refreshUsage()
    }
}

/// An embedding model on the service's own machine (docs/design/12 §4.3): a
/// guide to running one, and its endpoint for the service's embed slots. The
/// service takes its vectors only once they match the pool's — checked here
/// before saving, and again when saved — and spot-checks them after.
struct LocalEmbeddingSection: View {
    @EnvironmentObject private var app: AppModel
    @Binding var config: KnodeConfig?
    @State private var baseUrl = ""
    @State private var model = ""
    @State private var apiKey = ""
    @State private var loadedFrom: EmbedEndpointConfig?
    @State private var check: EmbedEndpointCheck?
    @State private var status = ""
    @State private var working = false
    @State private var showGuide = false

    private var ingest: Binding<IngestConfig> {
        Binding(get: { config?.ingest ?? IngestConfig() }, set: { config?.ingest = $0 })
    }
    private var poolModel: String { config?.embeddingPool?.model.isEmpty == false ? config!.embeddingPool!.model : "bge-m3" }
    private var draft: EmbedEndpointConfig? {
        let url = baseUrl.trimmingCharacters(in: .whitespaces)
        guard !url.isEmpty else { return nil }
        return EmbedEndpointConfig(baseUrl: url, model: model.trimmingCharacters(in: .whitespaces), apiKey: apiKey.isEmpty ? nil : apiKey)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(L("Embedding on this machine"), systemImage: "cpu")
                    .font(.headline).foregroundStyle(Color.knodeCyan)
                Spacer()
                Text(ingest.wrappedValue.embedEndpoint?.baseUrl ?? L("no endpoint of its own"))
                    .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary)
            }
            Text(L("Run the pool's model on the service's machine and its embed slots use it instead of the pool's daily quota. Its vectors are taken only once they match the pool's, checked with 16 fixed texts, and spot-checked after; when they stop matching, the slots go back to the pool."))
                .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            DisclosureGroup(L("Set up a local embedding model, step by step"), isExpanded: $showGuide) {
                VStack(alignment: .leading, spacing: 10) {
                    step(1, L("Run an OpenAI-compatible embeddings server on the service's machine that serves the pool's model (%@, 1024 dimensions), on 127.0.0.1 only. Any of these works:", poolModel))
                    option(L("Ollama — the lightest to set up"), L("Install it, then run the command below. URL http://127.0.0.1:11434/v1, model bge-m3."), "ollama pull bge-m3")
                    option(L("Text Embeddings Inference (Hugging Face)"), L("Or its Docker image, with the port bound to 127.0.0.1. URL http://127.0.0.1:12020/v1, model BAAI/bge-m3."), "text-embeddings-router --model-id BAAI/bge-m3 --hostname 127.0.0.1 --port 12020")
                    option(L("A small Python server — what was tested here"), L("BAAI/bge-m3 with transformers on the Apple GPU (MPS) in fp16: the CLS token's vector, L2-normalized, 1024 dimensions, up to 8,192 tokens, behind POST /v1/embeddings. About 4 GB of memory and 17,500 tokens/s on an M5 Pro; its vectors matched the pool's at cosine 0.9999 or better."), nil)
                    Text(L("A different or smaller model (bge-small, nomic-embed…) makes vectors in another space and cannot share this pool: the check refuses it. To use one, make it the pool model instead, which re-embeds the workspace."))
                        .font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    step(2, L("See that it answers, with 1024 numbers per text:"))
                    code("curl -s http://127.0.0.1:12020/v1/embeddings -H 'content-type: application/json' -d '{\"model\":\"BAAI/bge-m3\",\"input\":[\"你好\",\"hello\"]}'")
                    step(3, L("Enter its URL and model below and press Check endpoint. It embeds the probe texts there and compares each vector with the pool's; every one must reach cosine 0.98."))
                    step(4, L("Save & apply. The workspace switches to deferred embedding: a sync writes chunks at once and the embed slots fill in their vectors on your endpoint. The save checks the endpoint once more."))
                    step(5, L("Other machines can lend theirs too, with the worker and a token with the embed scope:"))
                    code("node knode-worker.mjs --backends embed:2 --embed-base-url http://127.0.0.1:12020/v1 --embed-model BAAI/bge-m3")
                }.padding(.top, 8)
            }.font(.caption)
            HStack(alignment: .top, spacing: 12) {
                field(L("Endpoint URL"), TextField("http://127.0.0.1:12020/v1", text: $baseUrl))
                field(L("Model"), TextField("BAAI/bge-m3", text: $model)).frame(width: 160)
                field(L("Key (optional)"), SecureField(L("none, or env:VAR"), text: $apiKey)).frame(width: 150)
            }
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Vectors made")).font(.caption).foregroundStyle(.secondary)
                    Picker("", selection: ingest.embedding) {
                        Text(L("while syncing (inline)")).tag("inline")
                        Text(L("by embed slots, after (deferred)")).tag("deferred")
                    }.labelsHidden().frame(width: 240)
                }
                VStack(alignment: .leading, spacing: 5) {
                    Text(L("Embed slots here")).font(.caption).foregroundStyle(.secondary)
                    TextField("8", value: ingest.embedSlots, format: .number).frame(width: 70)
                }
                Spacer()
                Button(L("Check endpoint")) { Task { await runCheck() } }
                    .disabled(working || draft == nil || model.trimmingCharacters(in: .whitespaces).isEmpty)
                Button(L("Remove")) { remove() }.disabled(working || ingest.wrappedValue.embedEndpoint == nil && baseUrl.isEmpty)
            }
            if !status.isEmpty {
                Text(status).font(.caption).textSelection(.enabled)
                    .foregroundStyle(check?.ok == true ? Color.knodeGood : check == nil ? Color.secondary : Color.orange)
            }
        }
        .padding(18)
        .background(Color.knodeCyan.opacity(0.03), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.knodeCyan.opacity(0.15)))
        .onAppear { load() }
        .onChange(of: config?.ingest.embedEndpoint) { _, saved in
            // a reload from the service (another workspace, a save) replaces the fields
            if saved != loadedFrom { load() }
        }
        .onChange(of: baseUrl) { _, _ in edited() }
        .onChange(of: model) { _, _ in edited() }
        .onChange(of: apiKey) { _, _ in edited() }
    }

    private func step(_ n: Int, _ text: String) -> some View {
        Text("\(n). \(text)").font(.caption).fixedSize(horizontal: false, vertical: true)
    }

    private func option(_ title: String, _ detail: String, _ command: String?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.caption).bold()
            if let command { code(command) }
            Text(detail).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }.padding(.leading, 14)
    }

    private func code(_ text: String) -> some View {
        Text(text).font(.system(size: 11, design: .monospaced)).textSelection(.enabled)
            .padding(6).frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 4))
    }

    private func field<Content: View>(_ title: String, _ content: Content) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            content.textFieldStyle(.roundedBorder)
        }
    }

    private func load() {
        let saved = config?.ingest.embedEndpoint
        loadedFrom = saved
        baseUrl = saved?.baseUrl ?? ""
        model = saved?.model ?? ""
        apiKey = saved?.apiKey ?? ""
        check = nil
        status = ""
    }

    /// The fields changed: the draft forgets its endpoint until it is checked again.
    private func edited() {
        guard let draft else {
            if config?.ingest.embedEndpoint != nil, baseUrl.isEmpty { config?.ingest.embedEndpoint = nil }
            return
        }
        if draft == loadedFrom { config?.ingest.embedEndpoint = loadedFrom; return }
        check = nil
        status = L("Changed: check it before saving.")
        // only a checked endpoint goes into the draft config; Save & apply checks it once more
        config?.ingest.embedEndpoint = loadedFrom
    }

    private func remove() {
        loadedFrom = nil
        baseUrl = ""; model = ""; apiKey = ""
        check = nil
        config?.ingest.embedEndpoint = nil
        status = L("Removed. Save & apply to embed on the pool only.")
    }

    private func runCheck() async {
        guard let draft else { return }
        working = true
        defer { working = false }
        status = L("Embedding the 16 probe texts on the endpoint and comparing them with the pool…")
        do {
            let result = try await app.client().checkEmbedEndpoint(draft)
            check = result
            if result.ok {
                config?.ingest.embedEndpoint = draft
                if config?.ingest.embedding != "deferred" { config?.ingest.embedding = "deferred" }
                if (config?.ingest.embedSlots ?? 0) < 1 { config?.ingest.embedSlots = 2 }
                loadedFrom = draft
                status = L("Passed: the lowest probe cosine against the pool's vectors is %@ (needs %@) · %@ ms. Save & apply to use it.",
                           String(format: "%.4f", result.minCosine ?? 0), String(format: "%.2f", result.threshold ?? 0.98), String(result.ms ?? 0))
            } else {
                status = L("Refused: %@", result.reason ?? result.error ?? L("the check failed"))
            }
        } catch {
            check = EmbedEndpointCheck(ok: false, reason: error.localizedDescription)
            status = L("Refused: %@", error.localizedDescription)
        }
    }
}

struct EmbeddingKeyRoutingFields: View {
    @Binding var entry: EmbeddingConnection
    let load: (Bool) async throws -> ModelListResponse
    let test: () async throws -> EmbeddingTestResponse
    @State private var status = ""
    @State private var working = false

    private var limits: Binding<EmbeddingLimits> {
        Binding(get: { entry.limits ?? EmbeddingLimits() }, set: { entry.limits = $0 })
    }
    private func optional<Value>(_ keyPath: WritableKeyPath<EmbeddingConnection, Value?>, _ fallback: Value) -> Binding<Value> {
        Binding(get: { entry[keyPath: keyPath] ?? fallback }, set: { entry[keyPath: keyPath] = $0 })
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Divider()
            HStack {
                Toggle(L("Include in model pools"), isOn: optional(\.enabled, true)).toggleStyle(.checkbox)
                Spacer()
                Text(L("Priority · lower first")).font(.caption).foregroundStyle(.secondary)
                TextField("10", value: optional(\.priority, 10), format: .number).frame(width: 65)
                Button(L("Test key")) { Task { await testKey() } }.disabled(working)
            }
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], alignment: .leading, spacing: 10) {
                numberField("Requests / minute", limits.requestsPerMinute)
                numberField("Tokens / minute", limits.tokensPerMinute)
                numberField("Concurrent requests", limits.concurrency)
                numberField("Requests / day", limits.requestsPerDay)
                numberField("Tokens / day", limits.tokensPerDay)
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("Daily reset timezone")).font(.caption).foregroundStyle(.secondary)
                    TextField("UTC", text: limits.resetTimezone)
                }
            }
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("Shared account quota group")).font(.caption).foregroundStyle(.secondary)
                    TextField(L("Same account → same group"), text: optional(\.quotaGroup, ""))
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("OpenRouter upstream (optional)")).font(.caption).foregroundStyle(.secondary)
                    TextField("deepinfra/fp32", text: optional(\.upstream, ""))
                }
            }
            if let note = entry.limitNote, !note.isEmpty {
                Text(note).font(.caption2).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text(L("Available embedding models · %@", String(entry.catalog?.count ?? 0))).font(.caption).bold()
                Spacer()
                Button(L("Refresh models")) { Task { await refresh() } }.disabled(working)
            }
            if let catalog = entry.catalog, !catalog.isEmpty {
                Text(catalog.joined(separator: "   ·   ")).font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(L("Refresh to list this key's embedding models. You can also enter its model ID above."))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !status.isEmpty { Text(status).font(.caption).textSelection(.enabled) }
        }
    }

    private func numberField(_ title: String, _ binding: Binding<Int>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(L(title)).font(.caption).foregroundStyle(.secondary)
            TextField("0", value: binding, format: .number)
        }
    }
    private func refresh() async {
        working = true; defer { working = false }
        do {
            let result = try await load(true)
            if result.ok { entry.catalog = result.models.map(\.id); status = L("Catalog updated. Save & apply to keep it.") }
            else { status = result.error ?? result.note ?? L("Unavailable") }
        } catch { status = error.localizedDescription }
    }
    private func testKey() async {
        working = true; defer { working = false }
        do {
            let result = try await test()
            status = result.ok ? L("Key test passed · %@ dimensions", String(result.dimensions ?? 0)) : result.error ?? L("Unavailable")
        } catch { status = error.localizedDescription }
    }
}
