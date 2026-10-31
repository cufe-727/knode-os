import SwiftUI

/// The channels hybrid retrieval fuses (docs/design/20 D2), each with its
/// colour wherever a passage says which of them found it.
enum ExploreChannel: String, CaseIterable, Identifiable {
    case vector
    case keyword
    case graph

    var id: String { rawValue }

    @MainActor var label: String {
        switch self {
        case .vector: L("Semantic")
        case .keyword: L("Keyword")
        case .graph: L("Entity")
        }
    }

    @MainActor var hint: String {
        switch self {
        case .vector: L("Passages whose meaning is close to the query (vector similarity)")
        case .keyword: L("Passages that contain its words (full text; CJK by substrings)")
        case .graph: L("Passages that mention an entity the query names")
        }
    }

    var color: Color {
        switch self {
        case .vector: .knodeCyan
        case .keyword: .knodeGood
        case .graph: .knodeViolet
        }
    }

    var symbol: String {
        switch self {
        case .vector: "circle.hexagongrid"
        // no letters in it: "textformat" turns into 格式 under a Chinese system language
        case .keyword: "text.magnifyingglass"
        case .graph: "point.3.connected.trianglepath.dotted"
        }
    }
}

/// How a search runs: all three channels fused, multi-hop through the
/// entities the direct matches mention, or one channel alone.
enum ExploreMode: String, CaseIterable, Identifiable {
    case hybrid
    case sag
    case vector
    case keyword

    var id: String { rawValue }

    @MainActor var title: String {
        switch self {
        case .hybrid: L("Hybrid")
        case .sag: L("Multi-hop")
        case .vector: L("Semantic")
        case .keyword: L("Keyword")
        }
    }

    @MainActor var help: String {
        switch self {
        case .hybrid: L("Semantic, keyword and entity matches, fused by rank — what Ask and the research agents get")
        case .sag: L("Direct matches, then the passages reached through the entities they mention")
        case .vector: L("Vector similarity alone")
        case .keyword: L("Full-text matches alone")
        }
    }
}

/// The last search, kept on the model so a file opened from it and the way
/// back find it as it was. Only for the workspace and revision it was made in.
struct ExploreMemory {
    var workspaceID: String?
    var revision: Int
    var query: String
    var mode: ExploreMode
    var scope: String
    var result: ExploreResponse
    var channel: String?
    var groupByDocument: Bool
    var expanded: Set<String>
}

/// Marking the query's terms in text, and choosing the stretch of a passage to show.
enum TermMarks {
    static let color = Color(red: 1.0, green: 0.8, blue: 0.28)

    /// Terms worth marking: a CJK bigram inside a longer term would mark half the text.
    static func markable(_ terms: [String]) -> [String] {
        let list = Array(Set(terms.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }))
        return list
            .filter { term in !list.contains { $0 != term && $0.count > term.count && $0.localizedCaseInsensitiveContains(term) } }
            .sorted { $0.count > $1.count }
    }

    /// A passage as a person reads it, the way the web shows it: Markdown's
    /// marks off — frontmatter, heading hashes, emphasis, link brackets.
    static func plain(_ text: String) -> String {
        var out = text
        let rules: [(String, String)] = [
            (#"\A---\n[\s\S]*?\n---\n"#, ""),
            (#"(?m)^\s{0,3}#{1,6}\s+"#, ""),
            (#"\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]"#, "$2"),
            (#"\[\[([^\]|#]+)(?:#[^\]|]*)?\]\]"#, "$1"),
            (#"!?\[([^\]]*)\]\([^)]*\)"#, "$1"),
            (#"(\*\*|__)(.+?)\1"#, "$2"),
        ]
        for (pattern, template) in rules {
            out = out.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return out
    }

    /// Around the first term, not the first characters: the reason the passage is here.
    static func snippet(_ text: String, terms: [String], size: Int = 260) -> String {
        let flat = plain(text).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard flat.count > size else { return flat }
        let first = terms.compactMap { flat.range(of: $0, options: .caseInsensitive)?.lowerBound }.min()
        let offset = first.map { flat.distance(from: flat.startIndex, to: $0) } ?? 0
        let start = max(0, offset - size * 3 / 10)
        let end = min(flat.count, start + size)
        let lower = flat.index(flat.startIndex, offsetBy: start)
        let upper = flat.index(flat.startIndex, offsetBy: end)
        return (start > 0 ? "…" : "") + flat[lower..<upper] + (end < flat.count ? "…" : "")
    }

    /// `text` with every term marked, case-insensitively.
    static func marked(_ text: String, _ terms: [String], bold: Bool = false) -> AttributedString {
        var out = AttributedString()
        var cursor = text.startIndex
        while cursor < text.endIndex {
            var best: Range<String.Index>?
            for term in terms {
                guard let hit = text.range(of: term, options: .caseInsensitive, range: cursor..<text.endIndex) else { continue }
                if let current = best, hit.lowerBound > current.lowerBound || (hit.lowerBound == current.lowerBound && hit.upperBound <= current.upperBound) { continue }
                best = hit
            }
            guard let hit = best else {
                out.append(AttributedString(String(text[cursor...])))
                break
            }
            if hit.lowerBound > cursor { out.append(AttributedString(String(text[cursor..<hit.lowerBound]))) }
            var mark = AttributedString(String(text[hit]))
            mark.backgroundColor = color.opacity(0.32)
            if bold { mark.inlinePresentationIntent = .stronglyEmphasized }
            out.append(mark)
            cursor = hit.upperBound
        }
        return out
    }
}

/**
 * Explore → Search (docs/design/20 §3): the retrieval Ask and the research
 * agents use, asked to explain itself. Each passage says how each channel
 * ranked it; beside the passages stand the entities the query names — and
 * where it named them — their relations, and the claims about them. Either
 * read may fail without blanking the page.
 */
struct ExploreSearchView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    @State private var mode: ExploreMode = .hybrid
    /// Empty means the whole base, else a path prefix — the roots plus the folder picked in Files.
    @State private var scope = ""
    @State private var result: ExploreResponse?
    /// The scope `result` was read with; the response echoes its mode but not its scope.
    @State private var resultScope = ""
    @State private var isSearching = false
    @State private var failure: String?
    @State private var searchSeq = 0
    /// The channel the passages are filtered to; nil shows them all.
    @State private var channel: String?
    @State private var expanded: Set<String> = []
    @State private var groupByDocument = false
    @State private var showRelated = false
    /// The workspace's best-known entities, offered before the first search.
    @State private var tryNames: [String] = []
    @FocusState private var queryFocused: Bool

    private var scopeChoices: [String] {
        let roots = ["raw/docs", "raw/traces", "wiki"]
        var choices = roots
        if let picked = model.pickedDirectory, !picked.isEmpty, !roots.contains(picked) { choices.append(picked) }
        if !scope.isEmpty, !choices.contains(scope) { choices.append(scope) }
        return choices
    }

    var body: some View {
        VStack(spacing: 0) {
            queryBar
            Divider()
            content
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task { await arrive() }
        .onChange(of: model.pendingSearch) { _, pending in
            guard pending != nil, let text = model.consumePendingSearch() else { return }
            query = text
            Task { await search() }
        }
        .onChange(of: channel) { remember() }
        .onChange(of: groupByDocument) { remember() }
        .onChange(of: expanded) { remember() }
    }

    /* ------------------------------ query bar ----------------------------- */

    private var queryBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(L("Search passages, entities and relations…"), text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($queryFocused)
                .onSubmit { Task { await search() } }
            Picker(L("Mode"), selection: $mode) {
                ForEach(ExploreMode.allCases) { mode in Text(mode.title).tag(mode) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help(mode.help)
            Picker(L("Scope"), selection: $scope) {
                Text(L("Whole base")).tag("")
                ForEach(scopeChoices, id: \.self) { dir in Text("\(dir)/").tag(dir) }
            }
            .labelsHidden()
            .frame(width: 140)
            .help(L("Limit the search to a folder — the one picked in Files is offered here."))
            Button(L("Search")) { Task { await search() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeCyan)
                .disabled(query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isSearching)
            ProgressView()
                .controlSize(.small)
                .opacity(isSearching ? 1 : 0)
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
        // a new pick runs the search again; putting back the one the result was read with does not
        .onChange(of: mode) { if let result, result.mode != mode.rawValue { Task { await search() } } }
        .onChange(of: scope) { if result != nil, scope != resultScope { Task { await search() } } }
    }

    @ViewBuilder
    private var content: some View {
        if let result {
            summary(result)
            Divider()
            HSplitView {
                passagesColumn(result)
                    .frame(minWidth: 400, idealWidth: 640, maxWidth: .infinity, maxHeight: .infinity)
                sideColumn(result)
                    .frame(minWidth: 300, idealWidth: 370, maxWidth: 460, maxHeight: .infinity)
            }
        } else if isSearching {
            ProgressView(L("Searching — passages and the graph…"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let failure {
            EmptyState(symbol: "exclamationmark.triangle", title: L("Search failed"), message: failure)
        } else {
            intro
        }
    }

    /* -------------------------------- intro ------------------------------- */

    /// Before the first search: the three channels in words, and names to try.
    private var intro: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Eyebrow(text: L("Explore · Search"))
                Text(L("See what a query matches — and why"))
                    .font(.title2.weight(.semibold))
                Text(L("Every search runs the retrieval Ask and the research agents use, and shows each channel's part in it:"))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(alignment: .top, spacing: 12) {
                    ForEach(ExploreChannel.allCases) { channel in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 7) {
                                Image(systemName: channel.symbol)
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(channel.color)
                                Text(channel.label).font(.callout.weight(.semibold))
                            }
                            Text(channel.hint)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                        .padding(12)
                        .background(channel.color.opacity(0.07), in: RoundedRectangle(cornerRadius: 10))
                        .overlay { RoundedRectangle(cornerRadius: 10).stroke(channel.color.opacity(0.28)) }
                    }
                }
                Text(L("Beside the passages: the entities the query names — by name, alias or description — what they are related to, and the claims about them. Multi-hop follows those entities one step further."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if !tryNames.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(L("Try")).font(.callout).foregroundStyle(.tertiary)
                        FlowRow(spacing: 6) {
                            ForEach(tryNames, id: \.self) { name in
                                Button(name) { searchFor(name) }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                            }
                        }
                    }
                }
            }
            .padding(32)
            .frame(maxWidth: 780, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }

    /* ------------------------------- summary ------------------------------ */

    private func summary(_ r: ExploreResponse) -> some View {
        let documents = Set(r.passages.map(\.path)).count
        let named = r.entities.filter { $0.match != nil }.count
        let typed = r.relations.filter { $0.type != "co_occurs" }.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(summaryLine(passages: r.passages.count, documents: documents, entities: named, relations: typed))
                    .font(.callout)
                if let total = r.ms?.total {
                    Text("· \(L("%@ ms", String(total))) · \(ExploreMode(rawValue: r.mode)?.title ?? r.mode)")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            FlowRow(spacing: 6) {
                ForEach(ExploreChannel.allCases) { channel in
                    if let stats = r.channels[channel.rawValue] { channelChip(channel, stats) }
                }
                if r.mode == ExploreMode.sag.rawValue {
                    Text(L("Multi-hop: direct matches, then passages reached through the entities they mention"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 4)
                }
                let terms = TermMarks.markable(r.terms)
                if !terms.isEmpty {
                    Text(L("Terms"))
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 8)
                        .padding(.vertical, 4)
                    ForEach(terms, id: \.self) { term in
                        Text(term)
                            .font(.system(size: 11, design: .monospaced))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 3)
                            .background(TermMarks.color.opacity(0.16), in: RoundedRectangle(cornerRadius: 5))
                            .overlay { RoundedRectangle(cornerRadius: 5).stroke(TermMarks.color.opacity(0.35)) }
                            .help(L("Keyword and entity matching used this term"))
                    }
                }
            }
            if let error = r.errors["passages"] {
                banner(L("Passages failed: %@", error))
            }
            if let error = r.errors["graph"] {
                banner(L("The graph read failed: %@", error))
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .background(.bar)
    }

    private func summaryLine(passages: Int, documents: Int, entities: Int, relations: Int) -> AttributedString {
        func bold(_ n: Int) -> AttributedString {
            var a = AttributedString(n.formatted())
            a.inlinePresentationIntent = .stronglyEmphasized
            return a
        }
        // the template carries the words; the numbers are put in bold where its %@ stand
        let template = L("%@ passages in %@ documents · %@ entities named · %@ relations")
        let numbers = [passages, documents, entities, relations]
        var out = AttributedString()
        var index = 0
        for (i, part) in template.components(separatedBy: "%@").enumerated() {
            if i > 0, index < numbers.count {
                out.append(bold(numbers[index]))
                index += 1
            }
            out.append(AttributedString(part))
        }
        return out
    }

    private func channelChip(_ channel: ExploreChannel, _ stats: ExploreChannelStats) -> some View {
        let active = self.channel == channel.rawValue
        let failed = stats.error != nil
        let tint = failed ? Color.knodeBad : channel.color
        return Button {
            self.channel = active ? nil : channel.rawValue
        } label: {
            HStack(spacing: 6) {
                Circle().fill(tint).frame(width: 7, height: 7)
                Text(channel.label).font(.system(size: 11.5, weight: .semibold))
                Text(failed ? L("failed") : stats.hits.formatted())
                    .font(.system(size: 11.5, weight: .bold, design: .monospaced))
            }
            .foregroundStyle(failed ? Color.knodeBad : Color.primary)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(tint.opacity(active ? 0.24 : 0.09), in: Capsule())
            .overlay { Capsule().stroke(tint.opacity(active ? 0.85 : 0.32)) }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .disabled(failed)
        .help(stats.error.map { L("%@ could not answer: %@", channel.label, $0) }
            ?? L("%@ — %@ chunks in %@ ms. Click to show only its passages.", channel.hint, String(stats.hits), String(stats.ms ?? 0)))
    }

    private func banner(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(Color.orange)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 7))
            .overlay { RoundedRectangle(cornerRadius: 7).stroke(Color.orange.opacity(0.3)) }
            .textSelection(.enabled)
    }

    /* ------------------------------ passages ------------------------------ */

    private func filtered(_ r: ExploreResponse) -> [ExplorePassage] {
        guard let channel else { return r.passages }
        return r.passages.filter { $0.signals[channel] != nil || $0.ranks[channel] != nil }
    }

    private func passagesColumn(_ r: ExploreResponse) -> some View {
        let list = filtered(r)
        let terms = TermMarks.markable(r.terms)
        let ranks = Dictionary(r.passages.enumerated().map { ($1.id, $0 + 1) }, uniquingKeysWith: { first, _ in first })
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let channel, let picked = ExploreChannel(rawValue: channel) {
                    Text(L("%@ of %@ found by %@", String(list.count), String(r.passages.count), picked.label))
                        .font(.callout.weight(.semibold))
                    Button(L("Show all")) { self.channel = nil }
                        .buttonStyle(.link)
                        .font(.callout)
                } else {
                    Text(L("%@ ranked passages", String(r.passages.count)))
                        .font(.callout.weight(.semibold))
                }
                Spacer()
                Toggle(L("Group by document"), isOn: $groupByDocument)
                    .toggleStyle(.switch)
                    .controlSize(.mini)
                    .font(.callout)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            Divider()
            if list.isEmpty {
                EmptyState(
                    symbol: "text.magnifyingglass",
                    title: r.passages.isEmpty ? L("No passage matched") : L("%@ found none of these passages", ExploreChannel(rawValue: channel ?? "")?.label ?? ""),
                    message: r.passages.isEmpty
                        ? (r.entities.isEmpty ? L("Try other words, another mode, the whole base — or index more documents.") : L("The graph still knows the entities on the right."))
                        : L("Pick another channel, or show all of them.")
                )
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if groupByDocument {
                            ForEach(documentGroups(list, ranks: ranks)) { group in
                                documentCard(group, terms: terms)
                            }
                        } else {
                            ForEach(list) { passage in
                                passageCard(passage, rank: ranks[passage.id] ?? 0, terms: terms, response: r)
                            }
                        }
                    }
                    .padding(14)
                }
            }
        }
    }

    private func title(of passage: ExplorePassage) -> String {
        if let title = passage.title, !title.isEmpty { return title }
        return ((passage.path as NSString).lastPathComponent as NSString).deletingPathExtension
    }

    private func passageCard(_ p: ExplorePassage, rank: Int, terms: [String], response r: ExploreResponse) -> some View {
        let open = expanded.contains(p.id)
        return VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(rank)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 22, alignment: .trailing)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title(of: p))
                        .font(.system(size: 13.5, weight: .semibold))
                        .lineLimit(1)
                    Text(p.path)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(Color.knodeCyan.opacity(0.85))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if let date = p.docDate {
                    Text(date)
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                        .help(L("The source's date"))
                }
                Image(systemName: open ? "chevron.up" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
            .onTapGesture { toggle(p.id) }

            Text(TermMarks.marked(open ? TermMarks.plain(p.content).trimmingCharacters(in: .whitespacesAndNewlines) : TermMarks.snippet(p.content, terms: terms), terms))
                .font(.system(size: 12.5))
                .lineSpacing(2.5)
                .lineLimit(open ? nil : 3)
                .modifier(SelectableWhen(enabled: open))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 32)

            HStack(spacing: 6) {
                rankBadges(p)
                Spacer(minLength: 6)
                Text(p.score, format: .number.precision(.fractionLength(4)))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .help(L("Fused score"))
            }
            .padding(.leading, 32)

            if open {
                explanation(p, response: r)
                    .padding(.leading, 32)
                HStack {
                    Spacer()
                    Button(L("Open file"), systemImage: "arrow.up.forward.app") { model.openFile(p.path) }
                        .buttonStyle(.borderedProminent)
                        .tint(.knodeCyan)
                        .controlSize(.small)
                }
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(open ? Color.knodeCyan.opacity(0.06) : Color.primary.opacity(0.035)))
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(open ? Color.knodeCyan.opacity(0.4) : Color.primary.opacity(0.08)) }
        .contentShape(Rectangle())
        // a collapsed card opens anywhere; an open one only from its head, so its text can be selected
        .onTapGesture { if !open { toggle(p.id) } }
    }

    @ViewBuilder
    private func rankBadges(_ p: ExplorePassage) -> some View {
        if let bridges = p.trace?.bridgeEntities, !bridges.isEmpty {
            RankBadge(text: L("via %@", bridges.joined(separator: " → ")), color: .orange)
                .help(L("Reached %@ hop(s) from a direct match through these entities", String(p.trace?.hop ?? 1)))
        } else {
            ForEach(ExploreChannel.allCases.filter { p.ranks[$0.rawValue] != nil || p.signals[$0.rawValue] != nil }) { channel in
                RankBadge(text: p.ranks[channel.rawValue].map { "\(channel.label) #\($0)" } ?? channel.label, color: channel.color)
                    .help(channel.hint)
            }
        }
    }

    /// How the fused score came about, in words a person can check.
    private func explanation(_ p: ExplorePassage, response r: ExploreResponse) -> some View {
        let found = ExploreChannel.allCases.filter { p.signals[$0.rawValue] != nil }
        let missing = ExploreChannel.allCases.filter { p.signals[$0.rawValue] == nil && r.channels[$0.rawValue] != nil }
        return VStack(alignment: .leading, spacing: 5) {
            ForEach(found) { channel in
                HStack(spacing: 8) {
                    RankBadge(text: p.ranks[channel.rawValue].map { "\(channel.label) #\($0)" } ?? channel.label, color: channel.color)
                    Text(rawSignal(channel, p.signals[channel.rawValue] ?? 0))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            if let structural = p.signals["structural"] {
                HStack(spacing: 8) {
                    RankBadge(text: L("Multi-hop"), color: .orange)
                    Text(L("structural score %@", structural.formatted(.number.precision(.fractionLength(3)))))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Text(L("Fused score %@ — each channel adds 1 / (60 + rank), entity × 0.6, nudged by how often the document is read.", p.score.formatted(.number.precision(.fractionLength(4))))
                + (missing.isEmpty ? "" : " " + L("Not found by %@.", missing.map(\.label).joined(separator: L(" or ")))))
                .font(.caption)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
    }

    private func rawSignal(_ channel: ExploreChannel, _ value: Double) -> String {
        switch channel {
        case .vector:
            return L("similarity %@", value.formatted(.number.precision(.fractionLength(3))))
        case .keyword:
            return value >= 1 ? L("%@ terms found", String(Int(value.rounded()))) : L("text rank %@", value.formatted(.number.precision(.fractionLength(3))))
        case .graph:
            return L("%@ named entities mentioned", String(Int(value.rounded())))
        }
    }

    private struct DocumentGroup: Identifiable {
        var path: String
        var title: String
        var date: String?
        var best: Int
        var passages: [ExplorePassage]
        var channels: [ExploreChannel]
        var id: String { path }
    }

    private func documentGroups(_ list: [ExplorePassage], ranks: [String: Int]) -> [DocumentGroup] {
        var order: [String] = []
        var groups: [String: DocumentGroup] = [:]
        for p in list {
            if groups[p.path] == nil {
                order.append(p.path)
                groups[p.path] = DocumentGroup(path: p.path, title: title(of: p), date: p.docDate, best: ranks[p.id] ?? 0, passages: [], channels: [])
            }
            groups[p.path]?.passages.append(p)
            for channel in ExploreChannel.allCases where p.signals[channel.rawValue] != nil || p.ranks[channel.rawValue] != nil {
                if groups[p.path]?.channels.contains(channel) == false { groups[p.path]?.channels.append(channel) }
            }
        }
        return order.compactMap { path in
            groups[path].map { group in
                var sorted = group
                sorted.channels.sort { a, b in ExploreChannel.allCases.firstIndex(of: a)! < ExploreChannel.allCases.firstIndex(of: b)! }
                return sorted
            }
        }
    }

    private func documentCard(_ group: DocumentGroup, terms: [String]) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text("\(group.best)")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 22, alignment: .trailing)
                    .help(L("Its best passage's place"))
                VStack(alignment: .leading, spacing: 2) {
                    Text(group.title).font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
                    Text(group.path)
                        .font(.system(size: 10.5, design: .monospaced))
                        .foregroundStyle(Color.knodeCyan.opacity(0.85))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if let date = group.date {
                    Text(date).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                Button(L("Open")) { model.openFile(group.path) }
                    .controlSize(.small)
            }
            HStack(spacing: 6) {
                ForEach(group.channels) { channel in RankBadge(text: channel.label, color: channel.color) }
                Text(group.passages.count == 1 ? L("1 passage") : L("%@ passages", String(group.passages.count)))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.leading, 32)
            ForEach(group.passages.prefix(4)) { passage in
                Text(TermMarks.marked(TermMarks.snippet(passage.content, terms: terms, size: 180), terms))
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 32)
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.035)))
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(Color.primary.opacity(0.08)) }
    }

    /* ---------------------------- side column ----------------------------- */

    private func sideColumn(_ r: ExploreResponse) -> some View {
        let terms = TermMarks.markable(r.terms)
        let named = r.entities.filter { $0.match != nil }
        let related = r.entities.filter { $0.match == nil }
        let typed = r.relations.filter { $0.type != "co_occurs" }
        let together = r.relations.filter { $0.type == "co_occurs" }
        let byID = Dictionary(r.entities.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let byName = Dictionary(r.entities.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
        // claims about what the query names first, then about what is related to it
        let namedNames = Set(named.map(\.name))
        let claims = r.claims.enumerated()
            .sorted { a, b in
                let x = namedNames.contains(a.element.subject), y = namedNames.contains(b.element.subject)
                return x != y ? x : a.offset < b.offset
            }
            .map(\.element)
        return ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if r.entities.isEmpty && r.claims.isEmpty {
                    sideSection(L("Entities"), count: nil) {
                        Text(r.errors["graph"] != nil
                            ? L("The graph read failed.")
                            : L("The query names no entity the graph knows — no name, alias or description holds its terms."))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                } else {
                    sideSection(L("Named in the query"), count: named.count) {
                        if named.isEmpty {
                            Text(L("No entity holds these terms; the ones below are related to the passages."))
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        ForEach(named) { entity in entityCard(entity, terms: terms) }
                    }
                    if !related.isEmpty {
                        DisclosureGroup(isExpanded: $showRelated) {
                            VStack(alignment: .leading, spacing: 2) {
                                ForEach(related) { entity in relatedRow(entity) }
                            }
                            .padding(.top, 6)
                        } label: {
                            sectionHeader(L("Related"), count: related.count)
                                .help(L("Entities one relation away from the ones the query names"))
                        }
                    }
                    if !typed.isEmpty {
                        sideSection(L("Relations"), count: typed.count) {
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(typed.prefix(40)) { relation in
                                    Text(relationLine(relation, byID: byID))
                                        .font(.system(size: 12))
                                        .fixedSize(horizontal: false, vertical: true)
                                        .help(relation.description.isEmpty ? relation.type : relation.description)
                                }
                                if typed.count > 40 {
                                    Text(L("and %@ more — open the graph to see them all", String(typed.count - 40)))
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    if !together.isEmpty {
                        sideSection(L("Often mentioned together"), count: together.count) {
                            VStack(alignment: .leading, spacing: 5) {
                                ForEach(together.prefix(20)) { relation in
                                    Text(togetherLine(relation, byID: byID))
                                        .font(.system(size: 12))
                                        .fixedSize(horizontal: false, vertical: true)
                                        .help(relation.description)
                                }
                            }
                        }
                    }
                    if !claims.isEmpty {
                        sideSection(L("Claims"), count: claims.count) {
                            ForEach(claims) { claim in claimCard(claim, terms: terms, byName: byName) }
                        }
                    }
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(Color.primary.opacity(0.02))
    }

    private func sectionHeader(_ title: String, count: Int?) -> some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 10, weight: .bold, design: .monospaced))
                .tracking(1.1)
                .foregroundStyle(.secondary)
            if let count {
                Text("\(count)")
                    .font(.system(size: 10, weight: .bold, design: .monospaced))
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func sideSection<Content: View>(_ title: String, count: Int?, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader(title, count: count)
            content()
        }
    }

    private func why(_ entity: ExploreEntity, terms: [String]) -> AttributedString {
        guard let match = entity.match else { return AttributedString(L("Related to what the query names")) }
        switch match.field {
        case "name":
            return AttributedString(L("Matched by its name"))
        case "alias":
            var out = AttributedString(L("Matched by alias") + " “")
            out.append(TermMarks.marked(match.text, terms, bold: true))
            out.append(AttributedString("”"))
            return out
        default:
            var out = AttributedString(L("Matched by its description:") + " ")
            out.append(TermMarks.marked(TermMarks.snippet(match.text, terms: [match.term], size: 90), terms))
            return out
        }
    }

    private func entityCard(_ entity: ExploreEntity, terms: [String]) -> some View {
        let color = nodeColor(entity.type)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 7) {
                Circle().fill(color).frame(width: 9, height: 9)
                Text(TermMarks.marked(entity.name, terms))
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(1)
                Text(entity.type)
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundStyle(color)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(color.opacity(0.14), in: Capsule())
                Spacer(minLength: 0)
            }
            Text(why(entity, terms: terms))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !entity.description.isEmpty, entity.match?.field != "description" {
                Text(TermMarks.plain(entity.description))
                    .font(.caption)
                    .lineLimit(2)
                    .help(entity.description)
            }
            Text(L("%@ mentions · %@ relations", entity.mentionCount.formatted(), entity.degree.formatted()))
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(.tertiary)
            HStack(spacing: 6) {
                Button { model.exploreEntity(entity.name) } label: {
                    Label(L("Graph"), systemImage: "point.3.connected.trianglepath.dotted")
                }
                .help(L("Open the graph around it"))
                if let wiki = entity.wikiPath {
                    Button { model.openFile(wiki) } label: { Label(L("Wiki page"), systemImage: "book.closed") }
                        .help(wiki)
                }
                Button { searchFor(entity.name) } label: { Label(L("Search for it"), systemImage: "magnifyingglass") }
                    .help(L("Search for its name"))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(color.opacity(0.07)))
        .overlay { RoundedRectangle(cornerRadius: 10).stroke(color.opacity(0.32)) }
    }

    private func relatedRow(_ entity: ExploreEntity) -> some View {
        HStack(spacing: 7) {
            Circle().fill(nodeColor(entity.type)).frame(width: 7, height: 7)
            Text(entity.name).font(.system(size: 12, weight: .medium)).lineLimit(1)
            Text(entity.type).font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            Spacer(minLength: 4)
            Text("\(entity.mentionCount)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(.tertiary)
                .help(L("%@ mentions · %@ relations", entity.mentionCount.formatted(), entity.degree.formatted()))
            Button { model.exploreEntity(entity.name) } label: { Image(systemName: "point.3.connected.trianglepath.dotted") }
                .help(L("Open the graph around it"))
            if let wiki = entity.wikiPath {
                Button { model.openFile(wiki) } label: { Image(systemName: "book.closed") }
                    .help(wiki)
            }
            Button { searchFor(entity.name) } label: { Image(systemName: "magnifyingglass") }
                .help(L("Search for its name"))
        }
        .buttonStyle(.borderless)
        .font(.system(size: 11))
        .padding(.vertical, 3)
        .help(entity.description)
    }

    private func name(_ id: String, _ byID: [String: ExploreEntity]) -> AttributedString {
        var out = AttributedString(byID[id]?.name ?? id)
        out.inlinePresentationIntent = .stronglyEmphasized
        if let entity = byID[id] { out.foregroundColor = nodeColor(entity.type).opacity(0.95) }
        return out
    }

    /// "A —competes with→ B", the arrow left off where the relation reads the same both ways.
    private func relationLine(_ relation: ExploreRelation, byID: [String: ExploreEntity]) -> AttributedString {
        var out = name(relation.source, byID)
        let arrow = GraphPalette.undirected.contains(relation.type) ? "—" : "→"
        var type = AttributedString(" —\(GraphRenderer.relationName(relation.type))\(arrow) ")
        type.foregroundColor = GraphPalette.family(of: relation.type).color
        out.append(type)
        out.append(name(relation.target, byID))
        if relation.validFrom != nil || relation.validTo != nil {
            var window = AttributedString("  \(relation.validFrom ?? "…") – \(relation.validTo ?? "…")")
            window.foregroundColor = .secondary
            out.append(window)
        }
        return out
    }

    private func togetherLine(_ relation: ExploreRelation, byID: [String: ExploreEntity]) -> AttributedString {
        var out = name(relation.source, byID)
        var dot = AttributedString("  ·  ")
        dot.foregroundColor = .secondary
        out.append(dot)
        out.append(name(relation.target, byID))
        return out
    }

    private func claimCard(_ claim: ExploreClaim, terms: [String], byName: [String: ExploreEntity]) -> some View {
        let disputed = claim.status == "disputed"
        var text = AttributedString(claim.subject)
        text.inlinePresentationIntent = .stronglyEmphasized
        if let entity = byName[claim.subject] { text.foregroundColor = nodeColor(entity.type) }
        text.append(AttributedString("  "))
        text.append(TermMarks.marked(claim.statement, terms))
        return VStack(alignment: .leading, spacing: 6) {
            Text(text)
                .font(.system(size: 12))
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
            HStack(spacing: 6) {
                Text(L(claim.status))
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                    .foregroundStyle(disputed ? Color.knodeBad : claim.status == "fact" ? Color.secondary : Color.orange)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background((disputed ? Color.knodeBad : Color.secondary).opacity(0.14), in: Capsule())
                if let kind = claim.kind, kind != "fact" {
                    Text(kind).font(.caption2).foregroundStyle(.secondary)
                }
                if let date = claim.startDate {
                    Text(date).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                }
                if let n = claim.evidenceCount, n > 1 {
                    Text(L("%@ sources", String(n))).font(.caption2).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                if let path = claim.path {
                    Button((path as NSString).lastPathComponent) { model.openFile(path) }
                        .buttonStyle(.link)
                        .font(.system(size: 10.5, design: .monospaced))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(path)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 8).fill(disputed ? Color.knodeBad.opacity(0.08) : Color.primary.opacity(0.035)))
        .overlay { RoundedRectangle(cornerRadius: 8).stroke(disputed ? Color.knodeBad.opacity(0.5) : Color.primary.opacity(0.08)) }
        .help(disputed ? L("Disputed: another source says otherwise") : "")
    }

    /* ------------------------------ actions ------------------------------- */

    private func toggle(_ id: String) {
        if expanded.contains(id) { expanded.remove(id) } else { expanded.insert(id) }
    }

    private func searchFor(_ text: String) {
        query = text
        Task { await search() }
    }

    /// Back on the screen: the last search as it was, a search the field asked for, or the field to type in.
    private func arrive() async {
        if let memory = model.lastExplore, memory.revision == model.workspaceRevision, memory.workspaceID == model.activeWorkspace?.id {
            query = memory.query
            mode = memory.mode
            scope = memory.scope
            resultScope = memory.scope
            result = memory.result
            channel = memory.channel
            groupByDocument = memory.groupByDocument
            expanded = memory.expanded
        }
        if let pending = model.consumePendingSearch() {
            query = pending
            await search()
            return
        }
        if result == nil {
            queryFocused = true
            if let page = try? await model.client().entities(sort: "mentions", limit: 8) {
                tryNames = page.items.map(\.name)
            }
        }
    }

    private func remember() {
        guard let result else { return }
        model.lastExplore = ExploreMemory(
            workspaceID: model.activeWorkspace?.id,
            revision: model.workspaceRevision,
            query: query,
            mode: mode,
            scope: scope,
            result: result,
            channel: channel,
            groupByDocument: groupByDocument,
            expanded: expanded
        )
    }

    private func search() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        searchSeq += 1
        let mine = searchSeq
        isSearching = true
        failure = nil
        defer { if mine == searchSeq { isSearching = false } }
        let asked = scope
        do {
            let answer = try await model.client().explore(text, mode: mode.rawValue, sources: asked)
            guard mine == searchSeq else { return }
            resultScope = asked
            result = answer
            channel = nil
            expanded = []
            remember()
        } catch {
            guard mine == searchSeq else { return }
            if result == nil { failure = error.localizedDescription }
            model.showError(error, prefix: L("Search failed"))
        }
    }
}

/// A channel's rank on a passage: "Semantic #2".
struct RankBadge: View {
    let text: String
    var color: Color = .knodeCyan

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(color)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(color.opacity(0.11), in: Capsule())
            .overlay { Capsule().stroke(color.opacity(0.3)) }
    }
}

/// Text selection only where it does not fight a tap.
private struct SelectableWhen: ViewModifier {
    let enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.textSelection(.enabled)
        } else {
            content
        }
    }
}
