import SwiftUI

/**
 * Knowledge → Entities: every live entity, in a table the service pages,
 * filters and sorts (`GET /api/entities`, src/store/entities.ts). The columns
 * are the numbers that say what an entity is worth — the chunks and documents
 * that mention it, its typed relations, the evidence behind it and which
 * extractors wrote that evidence — so a row answers "is this real, and where
 * does it come from" before anyone opens the graph.
 *
 * Sorting is the server's: a header click changes the request, not the order
 * of the fifty rows in hand. Typing waits 300 ms for the next keystroke, and
 * every change of the request cancels the load in flight, so a reply that
 * would have arrived after a newer request never lands.
 */
struct EntitiesView: View {
    @EnvironmentObject private var model: AppModel
    @State private var query = ""
    /// One type to show alone; empty is every type.
    @State private var type = ""
    @State private var merged = false
    @State private var offset = 0
    @State private var limit = 50
    @State private var sortOrder = [KeyPathComparator(\EntityItem.mentions, order: .reverse)]
    @State private var page: EntityPage?
    /// The type counts of the last reply, kept while the next one loads so the picker does not flicker.
    @State private var typeCounts: [GraphInsights.TypeCount] = []
    @State private var selection: EntityItem.ID?
    @State private var inFlight = 0
    /// The text the last request asked for; a different one is debounced.
    @State private var loadedQuery = ""

    /// Which sortable column asks for which server sort, and whether it reads best largest first.
    private static let sorts: [PartialKeyPath<EntityItem>: (key: String, descending: Bool)] = [
        \EntityItem.name: ("name", false),
        \EntityItem.type: ("type", false),
        \EntityItem.mentions: ("mentions", true),
        \EntityItem.evidence: ("evidence", true),
        \EntityItem.updatedKey: ("updated", true),
    ]

    /// Everything the request depends on; `.task(id:)` reloads when any of it changes.
    private struct Request: Equatable {
        var q: String
        var type: String
        var merged: Bool
        var offset: Int
        var limit: Int
        var sort: String
        var order: String
    }

    private var request: Request {
        let (sort, order) = serverSort
        return Request(
            q: query.trimmingCharacters(in: .whitespacesAndNewlines),
            type: type, merged: merged, offset: offset, limit: limit, sort: sort, order: order
        )
    }

    private var serverSort: (String, String) {
        guard let first = sortOrder.first, let sort = Self.sorts[first.keyPath] else { return ("mentions", "desc") }
        return (sort.key, first.order == .forward ? "asc" : "desc")
    }

    private var isLoading: Bool { inFlight > 0 }
    private var isFiltered: Bool { !request.q.isEmpty || !type.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            content
        }
        .task(id: request) { await load(request) }
        .onChange(of: query) { offset = 0 }
        .onChange(of: sortOrder) { old, new in
            offset = 0
            // a column picked afresh starts in the order it reads best in: counts and dates largest first
            guard let first = new.first, first.keyPath != old.first?.keyPath, first.order == .forward,
                  Self.sorts[first.keyPath]?.descending == true,
                  let flipped = Self.comparator(for: first.keyPath, order: .reverse) else { return }
            sortOrder = [flipped]
        }
    }

    private static func comparator(for keyPath: PartialKeyPath<EntityItem>, order: SortOrder) -> KeyPathComparator<EntityItem>? {
        if keyPath == \EntityItem.name { return KeyPathComparator(\EntityItem.name, order: order) }
        if keyPath == \EntityItem.type { return KeyPathComparator(\EntityItem.type, order: order) }
        if keyPath == \EntityItem.mentions { return KeyPathComparator(\EntityItem.mentions, order: order) }
        if keyPath == \EntityItem.evidence { return KeyPathComparator(\EntityItem.evidence, order: order) }
        if keyPath == \EntityItem.updatedKey { return KeyPathComparator(\EntityItem.updatedKey, order: order) }
        return nil
    }

    /* -------------------------------- bars -------------------------------- */

    private var topBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "tablecells")
                .foregroundStyle(Color.knodeViolet)
            TextField(L("Filter by name or alias…"), text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
            Picker(L("Type"), selection: Binding(get: { type }, set: { type = $0; offset = 0 })) {
                Text(L("All types")).tag("")
                ForEach(typeCounts) { item in
                    Text("\(item.type) · \(item.n.formatted())").tag(item.type)
                }
            }
            .labelsHidden()
            .frame(width: 190)
            Toggle(L("Merged"), isOn: Binding(get: { merged }, set: { merged = $0; offset = 0 }))
                .toggleStyle(.checkbox)
                .help(L("Include entities merged into another; by default a merged group answers once, as its survivor"))
            Text(L("%@ entities", (page?.total ?? 0).formatted()))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            if isLoading { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    private func bottomBar(_ page: EntityPage) -> some View {
        HStack(spacing: 10) {
            Button { offset = max(0, offset - limit) } label: { Image(systemName: "chevron.left") }
                .disabled(offset == 0)
                .help(L("Previous page"))
            Button { offset += limit } label: { Image(systemName: "chevron.right") }
                .disabled(offset + limit >= page.total)
                .help(L("Next page"))
            Text(L("%@–%@ of %@", (page.offset + 1).formatted(), min(page.offset + page.items.count, page.total).formatted(), page.total.formatted()))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            Spacer()
            Picker(L("Per page"), selection: Binding(get: { limit }, set: { limit = $0; offset = 0 })) {
                ForEach([25, 50, 100, 200], id: \.self) { n in Text(String(n)).tag(n) }
            }
            .frame(width: 170)
        }
        .padding(.horizontal, 18)
        .frame(height: 40)
        .background(.bar)
    }

    /* -------------------------------- body -------------------------------- */

    @ViewBuilder
    private var content: some View {
        if let page {
            if page.items.isEmpty {
                EmptyState(
                    symbol: "tablecells",
                    title: isFiltered ? L("No matching entities") : L("No entities yet"),
                    message: isFiltered
                        ? L("Try another name, alias, or type.")
                        : L("Index documents with wikilinks or configure entity extraction; entities appear as they are found."),
                    actionTitle: isFiltered ? nil : L("Go to Files"),
                    action: isFiltered ? nil : { model.select(.files) }
                )
            } else {
                table(page)
                Divider()
                bottomBar(page)
            }
        } else {
            ProgressView(L("Loading entities…"))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func table(_ page: EntityPage) -> some View {
        Table(page.items, selection: $selection, sortOrder: $sortOrder) {
            TableColumn(L("Name"), value: \.name) { item in
                Button { model.exploreEntity(item.name) } label: {
                    Text(item.name)
                        .fontWeight(.medium)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(L("Explore in graph"))
            }
            .width(min: 150, ideal: 230)
            TableColumn(L("Type"), value: \.type) { item in
                RouteBadge(label: item.type, color: nodeColor(item.type))
            }
            .width(min: 90, ideal: 120, max: 170)
            TableColumn(L("Mentions"), value: \.mentions) { item in
                number(item.mentions)
            }
            .width(min: 64, ideal: 80, max: 110)
            .alignment(.numeric)
            TableColumn(L("Documents")) { item in
                number(item.documents)
            }
            .width(min: 64, ideal: 84, max: 110)
            .alignment(.numeric)
            TableColumn(L("Relations")) { item in
                number(item.relations)
            }
            .width(min: 64, ideal: 80, max: 110)
            .alignment(.numeric)
            TableColumn(L("Evidence"), value: \.evidence) { item in
                number(item.evidence)
            }
            .width(min: 64, ideal: 80, max: 110)
            .alignment(.numeric)
            TableColumn(L("Sources")) { (item: EntityItem) in
                sources(item.sources)
            }
            .width(min: 90, ideal: 180)
            TableColumn(L("Aliases")) { (item: EntityItem) in
                Text(item.aliases.joined(separator: ", "))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(item.aliases.joined(separator: "\n"))
            }
            .width(min: 80, ideal: 160)
            TableColumn(L("Description")) { (item: EntityItem) in
                Text(item.description)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .help(item.description)
            }
            .width(min: 120, ideal: 280)
            Group {
                TableColumn(L("Updated"), value: \.updatedKey) { (item: EntityItem) in
                    Text(Self.shortDate(item.updatedAt))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
                .width(min: 90, ideal: 100, max: 130)
                TableColumn(L("Wiki")) { (item: EntityItem) in
                    if let path = item.wikiPath {
                        Button { model.openFile(path) } label: {
                            Image(systemName: "book.closed")
                                .foregroundStyle(Color.knodeCyan)
                        }
                        .buttonStyle(.plain)
                        .help(L("Open %@", path))
                    }
                }
                .width(min: 40, ideal: 44, max: 60)
            }
        }
        .contextMenu(forSelectionType: EntityItem.ID.self) { ids in
            if let item = item(in: ids) {
                Button(L("Explore in graph"), systemImage: "point.3.connected.trianglepath.dotted") {
                    model.exploreEntity(item.name)
                }
                Button(L("Open wiki page"), systemImage: "book.closed") {
                    if let path = item.wikiPath { model.openFile(path) }
                }
                .disabled(item.wikiPath == nil)
            }
        } primaryAction: { ids in
            if let item = item(in: ids) { model.exploreEntity(item.name) }
        }
    }

    private func item(in ids: Set<EntityItem.ID>) -> EntityItem? {
        page?.items.first { ids.contains($0.id) }
    }

    private func number(_ value: Int) -> some View {
        Text(value.formatted())
            .monospacedDigit()
            .frame(maxWidth: .infinity, alignment: .trailing)
    }

    /// One small badge per extractor family, the busiest first: "llm 5", "wikilink 2".
    private func sources(_ counts: [String: Int]) -> some View {
        HStack(spacing: 4) {
            ForEach(counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }, id: \.key) { family, n in
                Text("\(family) \(n.formatted())")
                    .font(.system(size: 9, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 2)
                    .background(Color.secondary.opacity(0.13), in: Capsule())
            }
        }
    }

    private static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain = ISO8601DateFormatter()

    private static func shortDate(_ iso: String?) -> String {
        guard let iso else { return "" }
        guard let date = isoWithFraction.date(from: iso) ?? isoPlain.date(from: iso) else { return String(iso.prefix(10)) }
        return date.formatted(date: .abbreviated, time: .omitted)
    }

    /* -------------------------------- data -------------------------------- */

    private func load(_ request: Request) async {
        // typing: wait for the pause before asking; anything else asks at once
        if page != nil, request.q != loadedQuery {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
        }
        loadedQuery = request.q
        inFlight += 1
        defer { inFlight -= 1 }
        do {
            let result = try await model.client().entities(
                q: request.q,
                types: request.type.isEmpty ? [] : [request.type],
                sort: request.sort,
                order: request.order,
                offset: request.offset,
                limit: request.limit,
                merged: request.merged
            )
            if Task.isCancelled { return }
            page = result
            typeCounts = result.typeCounts
        } catch {
            if Task.isCancelled { return }
            model.showError(error, prefix: "Entities failed")
        }
    }
}
