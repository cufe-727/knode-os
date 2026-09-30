import AppKit
import SwiftUI

// MARK: - Effort and speed

/// A rung of the reasoning-effort ladder, shared by every control that sets
/// one — a stage, a CLI agent, a research profile, a role — and by the
/// service, whose `LLM_EFFORTS` has the same ids.
struct EffortLevel: Identifiable, Hashable {
    let id: String
    /// English; goes through `L` at render time.
    let name: String

    static let all: [EffortLevel] = [
        EffortLevel(id: "low", name: "Low"),
        EffortLevel(id: "medium", name: "Medium"),
        EffortLevel(id: "high", name: "High"),
        EffortLevel(id: "xhigh", name: "Extra high"),
        EffortLevel(id: "max", name: "Max"),
        EffortLevel(id: "ultra", name: "Ultra"),
    ]

    /// What a CLI takes when its model list says nothing per model, as the
    /// service's `effortFor` hands it on: codex the whole ladder, claude up
    /// to Max, cursor up to High. A model endpoint takes none.
    static func ladder(for runtime: String) -> [EffortLevel] {
        switch runtime {
        case "codex-cli": all
        case "claude-cli": Array(all.prefix(5))
        case "cursor-cli": Array(all.prefix(3))
        default: []
        }
    }

    /// A level as the screen names it. An id this ladder does not know — a
    /// newer CLI's — shows as itself.
    @MainActor static func name(_ id: String) -> String {
        all.first { $0.id == id }.map { L($0.name) } ?? id
    }
}

/**
 * The effort and speed a model field sets beside its model, where that model
 * runs on a coding-agent CLI. An API endpoint takes neither, so its field
 * carries no chip.
 *
 * Where the field sits decides what "default" means: a stage follows its
 * agent, a role follows its profile, and an agent or a profile leaves it to
 * the CLI — whose own config may name a level (`defaults` in the model list).
 */
struct ModelTuning {
    var effort: Binding<String>
    /// Nil where nothing reads a speed.
    var speed: Binding<String>?
    /// "codex-cli" | "claude-cli" | "cursor-cli": the ladder when the list has
    /// no levels per model, and whether there is a Fast tier at all.
    var runtime: String
    /// What an unset level falls back to before the CLI's own: the agent's for
    /// a stage, the profile's for a role. Nil or "default" = nothing between.
    var inheritedEffort: String? = nil
    var inheritedSpeed: String? = nil
    /// Who that is, the way a sentence names it: "the agent", "the profile".
    var inheritedFrom: String = ""
    /// The level this job is usually worth — a research phase's advice.
    var recommended: String? = nil
    /// Where the setting is stored, when that is not the field's own record.
    var note: String? = nil
}

/// What a tuning comes to right now, and where each half of it comes from.
struct TuningSummary {
    enum Source { case own, inherited, cli, model, none }

    var effort: String?
    var effortSource: Source
    var fast: Bool
    var fastSource: Source

    init(_ tuning: ModelTuning, option: ModelOption?, defaults: CliDefaults?) {
        let own = tuning.effort.wrappedValue
        if own != "default" {
            (effort, effortSource) = (own, .own)
        } else if let inherited = tuning.inheritedEffort, inherited != "default" {
            (effort, effortSource) = (inherited, .inherited)
        } else if let configured = defaults?.effort, !configured.isEmpty {
            (effort, effortSource) = (configured, .cli)
        } else if let modelDefault = option?.defaultEffort {
            (effort, effortSource) = (modelDefault, .model)
        } else {
            (effort, effortSource) = (nil, .none)
        }
        if tuning.speed?.wrappedValue == "fast" {
            (fast, fastSource) = (true, .own)
        } else if tuning.inheritedSpeed == "fast" {
            (fast, fastSource) = (true, .inherited)
        } else if defaults?.speed == "fast" {
            (fast, fastSource) = (true, .cli)
        } else {
            (fast, fastSource) = (false, .none)
        }
    }
}

private extension Color {
    /// The Fast bolt: warm, so it reads as "on" beside the cyan effort fill.
    static let fastBolt = Color(red: 1.0, green: 0.76, blue: 0.28)
}

// MARK: - The model field

/// A model id stays free text — any id the provider accepts — with what the
/// provider actually offers dropping down from the field itself: its own
/// `/models`, the CLI's own list, or the aliases a CLI documents when it has
/// no list at all. Where the model runs on a CLI, how hard and how fast it
/// runs sits at the field's end, the way a chat composer shows "Opus · Max".
struct ModelField: View {
    let placeholder: String
    @Binding var text: String
    /**
     * The model that runs when this field is empty, shown greyed in its place.
     *
     * Never written. An empty `model` means "follow the provider", and pinning
     * the inherited string would stop the route tracking a later change to the
     * provider's own model — the propagation named connections exist for. The
     * list's first row is how you get back to inheriting.
     */
    var inherited: String = ""
    /// Changing provider invalidates a fetched list, since it came from the old one.
    var providerKey: String = ""
    var disabled = false
    /// Which entry of the shared catalog this field reads. Two fields pointed
    /// at the same route share one list instead of each asking.
    let route: String
    let load: (Bool) async throws -> ModelListResponse
    /// Effort and speed beside the model; nil where the field sets neither.
    var tuning: ModelTuning? = nil

    @EnvironmentObject private var catalog: ModelCatalog
    @State private var focused = false

    private var key: String { "\(route)|\(providerKey)" }
    private var result: ModelListResponse? { catalog.list(key) }

    /// Only a CLI takes an effort; an API model's field carries no chip.
    private var chip: ModelTuning? {
        guard let tuning, !EffortLevel.ladder(for: tuning.runtime).isEmpty else { return nil }
        return tuning
    }

    var body: some View {
        FieldLabel(L("Model")) {
            HStack(spacing: 0) {
                ModelComboBox(
                    text: $text,
                    placeholder: shownPlaceholder,
                    disabled: disabled,
                    content: content,
                    focused: $focused,
                    open: { Task { await reload() } },
                    refresh: { Task { await reload(force: true) } }
                )
                .padding(.leading, 7)
                if let chip, !disabled {
                    Rectangle()
                        .fill(Color.primary.opacity(0.12))
                        .frame(width: 1, height: 14)
                    TuningChip(tuning: chip, option: runningOption, defaults: result?.defaults, modelName: runningName)
                }
            }
            .frame(height: 24)
            .modelFieldChrome(focused: focused)
            .opacity(disabled ? 0.55 : 1)
            // the chip reads the list for its levels and the CLI's defaults
            .task(id: key) { if chip != nil { await reload() } }
        }
    }

    /// Greyed in the empty field: what runs instead — the inherited model, or
    /// the CLI's own default when its config names one.
    private var shownPlaceholder: String {
        if !inherited.isEmpty { return inherited }
        if let model = result?.defaults?.model, !model.isEmpty { return model }
        return placeholder
    }

    /// The model that runs: what is typed, else what the empty field falls back to.
    private var runningModel: String {
        if !text.isEmpty { return text }
        if !inherited.isEmpty { return inherited }
        return result?.defaults?.model ?? ""
    }

    private var runningOption: ModelOption? {
        let id = runningModel
        return id.isEmpty ? nil : result?.models.first { $0.id == id }
    }

    private var runningName: String {
        if let label = runningOption?.label, !label.isEmpty { return label }
        return runningModel.isEmpty ? L("CLI default model") : runningModel
    }

    private var content: ComboContent {
        ComboContent(
            options: result?.models ?? [],
            loading: catalog.isLoading(key),
            failure: catalog.failure(key) ?? result?.error,
            source: result?.source,
            note: result?.note,
            cachedAt: result?.cached == true ? result?.cachedAt : nil,
            emptyRow: emptyRowTitle,
            text: text
        )
    }

    /// The row that empties the field, saying what empty amounts to: the
    /// model it falls back to, when one is known.
    private var emptyRowTitle: String {
        let fallback = inherited.isEmpty ? (result?.defaults?.model ?? "") : inherited
        return fallback.isEmpty ? L("Leave empty") : L("Default · %@", fallback)
    }

    private func reload(force: Bool = false) async {
        await catalog.load(key, refresh: force, using: load)
    }
}

private struct ModelFieldChrome: ViewModifier {
    let focused: Bool
    /// A native field drops its focus ring while its window is not key.
    @Environment(\.controlActiveState) private var activeState

    /// Drawn to match the rounded text fields around it: the text itself is a
    /// borderless field, so the chip can sit inside the same frame.
    func body(content: Content) -> some View {
        let focused = focused && activeState == .key
        return content
            .background(Color(nsColor: .textBackgroundColor), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .strokeBorder(Color.primary.opacity(focused ? 0 : 0.13), lineWidth: 1)
            }
            .overlay {
                if focused {
                    RoundedRectangle(cornerRadius: 7.5, style: .continuous)
                        .strokeBorder(Color.accentColor.opacity(0.6), lineWidth: 3)
                        .padding(-2)
                        .allowsHitTesting(false)
                }
            }
    }
}

private extension View {
    func modelFieldChrome(focused: Bool) -> some View { modifier(ModelFieldChrome(focused: focused)) }
}

// MARK: - Effort chip

/// The effort (and Fast) at the end of a model field. Plain text, like the
/// "Opus 5.5 · Max" a chat composer shows; greyed while it only reports what
/// something else decides.
private struct TuningChip: View {
    let tuning: ModelTuning
    let option: ModelOption?
    let defaults: CliDefaults?
    let modelName: String

    @State private var showing = false

    var body: some View {
        let summary = TuningSummary(tuning, option: option, defaults: defaults)
        Button { showing.toggle() } label: {
            HStack(spacing: 3) {
                if summary.fast {
                    Image(systemName: "bolt.fill")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(summary.fastSource == .own ? Color.fastBolt : Color.secondary)
                }
                Text(summary.effort.map(EffortLevel.name) ?? L("Default"))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(summary.effortSource == .own ? Color.primary : Color.secondary)
                    .lineLimit(1)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 8)
            .frame(maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: true, vertical: false)
        .help(TuningText.chipHelp(tuning, summary, option: option))
        .accessibilityLabel(L("Reasoning effort"))
        .accessibilityValue(summary.effort.map(EffortLevel.name) ?? L("Default"))
        .popover(isPresented: $showing, arrowEdge: .bottom) {
            TuningPopover(tuning: tuning, option: option, defaults: defaults, modelName: modelName)
        }
    }
}

/// The chip's popover: the level as a slider with one stop per level the
/// model accepts, Fast at the top left and back-to-default at the top right.
private struct TuningPopover: View {
    let tuning: ModelTuning
    let option: ModelOption?
    let defaults: CliDefaults?
    let modelName: String

    var body: some View {
        let summary = TuningSummary(tuning, option: option, defaults: defaults)
        let stops = self.stops
        let index = summary.effort.flatMap { level in stops.firstIndex { $0.id == level } }
        VStack(spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                speedButton(summary)
                Spacer(minLength: 0)
                VStack(spacing: 2) {
                    Text(summary.effort.map(EffortLevel.name) ?? L("Default"))
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(summary.effortSource == .own ? Color.knodeCyan : Color.secondary)
                    Text(modelName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 0)
                resetButton
            }
            EffortSlider(
                stops: stops,
                index: index,
                own: summary.effortSource == .own,
                recommended: tuning.recommended.flatMap { level in stops.firstIndex { $0.id == level } },
                pick: { tuning.effort.wrappedValue = stops[$0].id }
            )
            VStack(alignment: .leading, spacing: 5) {
                ForEach(lines(summary, stops: stops, index: index), id: \.self) { line in
                    Text(line)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if summary.fast {
                    Label(fastLine(summary), systemImage: "bolt.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(14)
        .frame(width: 292)
    }

    /// The levels this model accepts when its list says, else the CLI's ladder.
    private var stops: [EffortOption] {
        if let efforts = option?.efforts, !efforts.isEmpty { return efforts }
        return EffortLevel.ladder(for: tuning.runtime).map { EffortOption(id: $0.id) }
    }

    /// Fast only where there is one: the model's list names it, or — with no
    /// list entry to ask — the CLI is codex, which drops a tier a model lacks.
    private var fastOption: SpeedOption? {
        guard tuning.speed != nil else { return nil }
        if let option { return option.speeds?.first { $0.id == "fast" } }
        return tuning.runtime == "codex-cli" ? SpeedOption(id: "fast") : nil
    }

    @ViewBuilder
    private func speedButton(_ summary: TuningSummary) -> some View {
        if let fast = fastOption, let speed = tuning.speed {
            // a Fast that comes from elsewhere cannot be switched off from here
            let locked = summary.fast && summary.fastSource != .own
            Button {
                speed.wrappedValue = speed.wrappedValue == "fast" ? "default" : "fast"
            } label: {
                Image(systemName: summary.fast ? "bolt.fill" : "bolt")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(summary.fast ? Color.fastBolt : Color.secondary)
                    .frame(width: 28, height: 28)
                    .background(
                        (summary.fast ? Color.fastBolt.opacity(0.16) : Color.primary.opacity(0.06)),
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
            }
            .buttonStyle(.plain)
            .disabled(locked)
            .help(locked
                ? L("Fast comes from %@ — switch it off there.", TuningText.source(summary.fastSource, tuning))
                : summary.fast ? L("Turn Fast off") : L("Turn on Fast — %@", fast.description.map(L) ?? L("quicker answers, at higher usage")))
            .accessibilityLabel(L("Fast"))
            .accessibilityValue(summary.fast ? L("On") : L("Off"))
        } else {
            Color.clear.frame(width: 28, height: 28)
        }
    }

    private var resetButton: some View {
        let changed = tuning.effort.wrappedValue != "default" || (tuning.speed?.wrappedValue ?? "default") != "default"
        return Button {
            tuning.effort.wrappedValue = "default"
            tuning.speed?.wrappedValue = "default"
        } label: {
            Image(systemName: "arrow.counterclockwise")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(changed ? Color.primary : Color.secondary.opacity(0.5))
                .frame(width: 28, height: 28)
                .background(Color.primary.opacity(changed ? 0.06 : 0), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(!changed)
        .help(tuning.inheritedFrom.isEmpty ? L("Back to the CLI's own setting") : L("Back to %@'s setting", tuning.inheritedFrom))
        .accessibilityLabel(L("Reset"))
    }

    /// What the level does and where it comes from, one sentence each.
    private func lines(_ summary: TuningSummary, stops: [EffortOption], index: Int?) -> [String] {
        var out: [String] = []
        if let index, let description = stops[index].description, !description.isEmpty {
            // the catalog's own words; the ones codex ships have a translation
            out.append(L(description))
        }
        if summary.effortSource == .own, index == nil, let level = summary.effort {
            out.append(L("%@ does not list %@ — the CLI may refuse it. Pick one of its levels.", modelName, EffortLevel.name(level)))
        }
        switch summary.effortSource {
        case .own: break
        case .none: out.append(L("Left to the CLI — drag to pick a level."))
        default: out.append(TuningText.fallback(summary, tuning, modelName: modelName))
        }
        if let recommended = tuning.recommended, recommended != "default" {
            out.append(L("Usually worth %@ in this phase.", EffortLevel.name(recommended)))
        }
        if let note = tuning.note { out.append(note) }
        return out
    }

    private func fastLine(_ summary: TuningSummary) -> String {
        let what = fastOption?.description.map(L) ?? L("quicker answers, at higher usage")
        guard summary.fastSource != .own else { return L("Fast · %@", what) }
        return L("Fast, from %@ · %@", TuningText.source(summary.fastSource, tuning), what)
    }
}

/// The sentences the chip and its popover share.
private enum TuningText {
    @MainActor static func source(_ source: TuningSummary.Source, _ tuning: ModelTuning) -> String {
        switch source {
        case .inherited: tuning.inheritedFrom
        case .cli: "~/.codex/config.toml"
        case .model: L("the model")
        case .own, .none: ""
        }
    }

    /// Where an effort nobody set here comes from.
    @MainActor static func fallback(_ summary: TuningSummary, _ tuning: ModelTuning, modelName: String) -> String {
        let level = summary.effort.map(EffortLevel.name) ?? ""
        return switch summary.effortSource {
        case .inherited: L("Follows %@: %@. Drag to set this one's own.", tuning.inheritedFrom, level)
        case .cli: L("From ~/.codex/config.toml: %@. Drag to set one here.", level)
        case .model: L("%@ runs at %@ unless told otherwise.", modelName, level)
        case .own, .none: ""
        }
    }

    @MainActor static func chipHelp(_ tuning: ModelTuning, _ summary: TuningSummary, option: ModelOption?) -> String {
        var parts = [L("Reasoning effort")]
        if let level = summary.effort {
            parts.append(summary.effortSource == .own ? EffortLevel.name(level) : L("%@ (%@)", EffortLevel.name(level), source(summary.effortSource, tuning)))
        } else {
            parts.append(L("the CLI's own setting"))
        }
        if summary.fast { parts.append(L("Fast")) }
        return parts.joined(separator: " · ")
    }
}

/// One stop per level, a knob on the chosen one and the track filled up to
/// it. A knob that only shows a fallback is drawn faint: dragging or clicking
/// makes the level this place's own.
private struct EffortSlider: View {
    let stops: [EffortOption]
    let index: Int?
    let own: Bool
    let recommended: Int?
    let pick: (Int) -> Void

    private let height: CGFloat = 26

    var body: some View {
        GeometryReader { geo in
            let step = stops.count > 1 ? (geo.size.width - height) / CGFloat(stops.count - 1) : 0
            let center = { (i: Int) in height / 2 + step * CGFloat(i) }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.09))
                if let index {
                    Capsule()
                        .fill(Color.knodeCyan.opacity(own ? 0.9 : 0.32))
                        .frame(width: center(index) + height / 2)
                }
                ForEach(stops.indices, id: \.self) { i in
                    Circle()
                        .fill(i <= (index ?? -1) ? Color.white.opacity(own ? 0.85 : 0.55) : Color.primary.opacity(0.28))
                        .frame(width: 5, height: 5)
                        .overlay {
                            if i == recommended {
                                Circle().strokeBorder(Color.knodeCyan.opacity(0.9), lineWidth: 1).frame(width: 11, height: 11)
                            }
                        }
                        .position(x: center(i), y: height / 2)
                        .help(EffortLevel.name(stops[i].id))
                }
                if let index {
                    Circle()
                        .fill(Color.white)
                        .shadow(color: .black.opacity(0.28), radius: 1.5, y: 0.5)
                        .frame(width: height - 4, height: height - 4)
                        .opacity(own ? 1 : 0.7)
                        .position(x: center(index), y: height / 2)
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                guard !stops.isEmpty else { return }
                let raw = step > 0 ? ((value.location.x - height / 2) / step).rounded() : 0
                let target = min(max(Int(raw), 0), stops.count - 1)
                if target != index || !own { pick(target) }
            })
        }
        .frame(height: height)
        .focusable()
        .focusEffectDisabled()
        .onMoveCommand { direction in
            guard !stops.isEmpty else { return }
            switch direction {
            case .left: pick(max((index ?? 1) - 1, 0))
            case .right: pick(min((index ?? -1) + 1, stops.count - 1))
            default: break
            }
        }
        .accessibilityElement()
        .accessibilityLabel(L("Reasoning effort"))
        .accessibilityValue(index.map { EffortLevel.name(stops[$0].id) } ?? L("Default"))
        .accessibilityAdjustableAction { direction in
            guard !stops.isEmpty else { return }
            switch direction {
            case .increment: pick(min((index ?? -1) + 1, stops.count - 1))
            case .decrement: pick(max((index ?? 1) - 1, 0))
            @unknown default: break
            }
        }
    }
}

// MARK: - The combo box

/// Everything the list shows, handed down from the field on every update.
struct ComboContent: Equatable {
    var options: [ModelOption] = []
    var loading = false
    var failure: String?
    var source: String?
    var note: String?
    var cachedAt: String?
    /// The row that empties the field, and what empty amounts to.
    var emptyRow: String = ""
    var text: String = ""
}

/// A row of the list: the empty row, whose id is "" — no model id is — or a model.
enum ComboRow: Identifiable, Equatable {
    case empty(String)
    case option(ModelOption)

    var id: String {
        switch self {
        case .empty: ""
        case .option(let option): option.id
        }
    }

    /// Everything, the empty row first, while nothing is typed; else the
    /// models that match, ids that start with the text first, then ids with a
    /// part that does (`sol` finds `gpt-6.1-sol`), then names, then anything
    /// containing it — each group in the provider's own order.
    static func rows(_ content: ComboContent, query: String?) -> [ComboRow] {
        let needle = (query ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        guard !needle.isEmpty else { return [.empty(content.emptyRow)] + content.options.map(ComboRow.option) }
        let ranked = content.options.enumerated().compactMap { index, option in
            rank(option, needle).map { (rank: $0, index: index, option: option) }
        }
        return ranked
            .sorted { ($0.rank, $0.index) < ($1.rank, $1.index) }
            .map { .option($0.option) }
    }

    private static func rank(_ option: ModelOption, _ needle: String) -> Int? {
        let id = option.id.lowercased()
        let label = (option.label ?? "").lowercased()
        if id.hasPrefix(needle) { return 0 }
        // "." stays inside a part, so a version like `6.1` is one
        let separators: (Character) -> Bool = { "-_/:[ ".contains($0) }
        if id.split(whereSeparator: separators).contains(where: { $0.hasPrefix(needle) }) { return 1 }
        if label.hasPrefix(needle) || label.split(whereSeparator: separators).contains(where: { $0.hasPrefix(needle) }) { return 2 }
        if id.contains(needle) || label.contains(needle) { return 3 }
        return nil
    }
}

/**
 * The text half of a model field: a borderless text field and the list
 * chevron, with the list in a child panel below it.
 *
 * AppKit underneath, because a SwiftUI popover takes the keyboard, and here
 * typing has to stay in the field: clicking the field opens the list, typing
 * filters it, ↑/↓ move through it, ↩ picks and ⎋ closes it with the text
 * kept as typed. The panel never becomes key, so the field keeps editing
 * while a click in the list picks.
 */
struct ModelComboBox: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var disabled: Bool
    var content: ComboContent
    @Binding var focused: Bool
    /// The list opened: fetch what it lists, if that has not happened yet.
    var open: () -> Void
    var refresh: () -> Void

    func makeCoordinator() -> ComboCoordinator { ComboCoordinator(self) }

    func makeNSView(context: Context) -> ComboFieldView {
        let view = ComboFieldView()
        view.textField.delegate = context.coordinator
        view.chevron.target = context.coordinator
        view.chevron.action = #selector(ComboCoordinator.toggleList)
        view.chevron.toolTip = L("List the models this provider offers")
        view.chevron.setAccessibilityLabel(L("List the models this provider offers"))
        view.textField.setAccessibilityLabel(L("Model"))
        view.onFocus = { [weak coordinator = context.coordinator] in coordinator?.focusChanged($0) }
        context.coordinator.attach(view)
        return view
    }

    func updateNSView(_ view: ComboFieldView, context: Context) {
        context.coordinator.parent = self
        let field = view.textField
        if field.stringValue != text { field.stringValue = text }
        field.placeholderString = placeholder
        field.isEnabled = !disabled
        view.chevron.isEnabled = !disabled
        context.coordinator.update(content)
    }

    static func dismantleNSView(_ view: ComboFieldView, coordinator: ComboCoordinator) {
        coordinator.detach()
    }
}

/// The field and its chevron. Tells its coordinator when the text gains or
/// loses the keyboard, which the field chrome draws as a focus ring.
final class ComboFieldView: NSView {
    let textField = FocusReportingTextField()
    let chevron = NSButton()
    var onFocus: ((Bool) -> Void)? {
        didSet { textField.onFocus = onFocus }
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        textField.isBordered = false
        textField.isBezeled = false
        textField.drawsBackground = false
        textField.focusRingType = .none
        textField.font = .systemFont(ofSize: NSFont.systemFontSize)
        textField.usesSingleLineMode = true
        textField.cell?.isScrollable = true
        textField.cell?.wraps = false
        textField.lineBreakMode = .byTruncatingTail
        textField.translatesAutoresizingMaskIntoConstraints = false
        textField.setContentHuggingPriority(.defaultLow, for: .horizontal)
        textField.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        chevron.image = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 9, weight: .semibold))
        chevron.isBordered = false
        chevron.imagePosition = .imageOnly
        chevron.contentTintColor = .secondaryLabelColor
        chevron.translatesAutoresizingMaskIntoConstraints = false

        addSubview(textField)
        addSubview(chevron)
        NSLayoutConstraint.activate([
            textField.leadingAnchor.constraint(equalTo: leadingAnchor),
            textField.centerYAnchor.constraint(equalTo: centerYAnchor),
            textField.trailingAnchor.constraint(equalTo: chevron.leadingAnchor, constant: -2),
            chevron.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            chevron.centerYAnchor.constraint(equalTo: centerYAnchor),
            chevron.widthAnchor.constraint(equalToConstant: 18),
            chevron.heightAnchor.constraint(equalToConstant: 20),
        ])
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 22) }
}

/// A text field that says when it takes and gives up the keyboard. Editing
/// happens in the window's field editor, so "has focus" means the editor is
/// this field's.
final class FocusReportingTextField: NSTextField {
    var onFocus: ((Bool) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFocus?(true) }
        return became
    }

    override func textDidEndEditing(_ notification: Notification) {
        super.textDidEndEditing(notification)
        onFocus?(false)
    }
}

/// Never key and never main, so the field below keeps the keyboard.
private final class ComboPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// Picks on the first click, although its window is not the key one.
private final class FirstClickHostingView<Content: View>: NSHostingView<Content> {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
final class ComboCoordinator: NSObject, NSTextFieldDelegate {
    var parent: ModelComboBox
    private weak var view: ComboFieldView?
    private var panel: ComboPanel?
    private var hosting: FirstClickHostingView<ComboList>?
    private var monitor: Any?
    private var windowObservers: [NSObjectProtocol] = []

    private var content = ComboContent()
    /// What was typed since the list opened; nil = opened by a click, so everything shows.
    private var query: String?
    private var highlighted: String?
    /// Bumped on every open, so the list scrolls the current model into view.
    private var opened = 0

    init(_ parent: ModelComboBox) {
        self.parent = parent
    }

    private var isOpen: Bool { panel?.isVisible == true }
    private var rows: [ComboRow] { ComboRow.rows(content, query: query) }

    func attach(_ view: ComboFieldView) {
        self.view = view
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel]) { [weak self] event in
            MainActor.assumeIsolated { self?.handle(event) }
            return event
        }
    }

    func detach() {
        close()
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
    }

    /// From `updateNSView`, so the list is redrawn after SwiftUI's pass, not inside it.
    func update(_ next: ComboContent) {
        guard next != content else { return }
        content = next
        guard isOpen else { return }
        DispatchQueue.main.async { [weak self] in self?.refreshOpenList() }
    }

    private func refreshOpenList() {
        if isOpen {
            // a list that just arrived highlights the current model, as an open does
            if query == nil, highlighted == nil || !rows.contains(where: { $0.id == highlighted }) {
                highlighted = rows.contains { $0.id == content.text } ? content.text : nil
            }
            render()
        }
    }

    /// A responder change can land inside a SwiftUI update, so the state it
    /// drives is written after it.
    func focusChanged(_ focused: Bool) {
        if !focused { close() }
        DispatchQueue.main.async { [weak self] in
            guard let self, self.parent.focused != focused else { return }
            self.parent.focused = focused
        }
    }

    // MARK: Events

    /// A click in the text opens the list, one anywhere else closes it; the
    /// chevron toggles through its own action, and the list takes its own
    /// clicks. Scrolling the page closes it too, since the field moves away.
    private func handle(_ event: NSEvent) {
        guard let view, let window = view.window else { return }
        if let panel, event.window === panel { return }
        if event.type == .scrollWheel {
            if event.window === window { close() }
            return
        }
        guard event.window === window else {
            close()
            return
        }
        let point = view.convert(event.locationInWindow, from: nil)
        if view.chevron.frame.contains(point) { return }
        if event.type == .leftMouseDown, view.bounds.contains(point), view.textField.isEnabled {
            if !isOpen { show(query: nil) }
        } else {
            close()
        }
    }

    @objc func toggleList() {
        guard let view else { return }
        if isOpen {
            close()
        } else {
            view.window?.makeFirstResponder(view.textField)
            show(query: nil)
        }
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = view?.textField else { return }
        let typed = field.stringValue
        parent.text = typed
        content.text = typed
        query = typed
        highlighted = rows.first { if case .option = $0 { true } else { false } }?.id
        if isOpen { render() } else { show(query: typed) }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)):
            if isOpen { move(1) } else { show(query: nil) }
            return true
        case #selector(NSResponder.moveUp(_:)):
            guard isOpen else { return false }
            move(-1)
            return true
        case #selector(NSResponder.insertNewline(_:)):
            guard isOpen else { return false }
            if let highlighted { pick(highlighted) } else { close() }
            return true
        case #selector(NSResponder.cancelOperation(_:)):
            guard isOpen else { return false }
            close()
            return true
        case #selector(NSResponder.insertTab(_:)), #selector(NSResponder.insertBacktab(_:)):
            close()
            return false
        default:
            return false
        }
    }

    private func move(_ delta: Int) {
        let ids = rows.map(\.id)
        guard !ids.isEmpty else { return }
        let current = highlighted.flatMap { ids.firstIndex(of: $0) }
        let next = current.map { min(max($0 + delta, 0), ids.count - 1) } ?? (delta > 0 ? 0 : ids.count - 1)
        highlighted = ids[next]
        render()
    }

    private func pick(_ id: String) {
        guard let field = view?.textField else { return }
        field.stringValue = id
        parent.text = id
        content.text = id
        close()
        // the caret after the new text, as if it had been typed
        if let editor = field.currentEditor() {
            editor.selectedRange = NSRange(location: (id as NSString).length, length: 0)
        }
    }

    // MARK: Panel

    private func show(query: String?) {
        guard let view, let window = view.window, view.textField.isEnabled else { return }
        self.query = query
        if query == nil {
            highlighted = rows.contains { $0.id == content.text } ? content.text : nil
        }
        opened += 1
        let panel = self.panel ?? makePanel()
        if !panel.isVisible {
            panel.appearance = window.effectiveAppearance
            window.addChildWindow(panel, ordered: .above)
            observe(window)
            parent.open()
        }
        render()
        panel.orderFront(nil)
    }

    private func close() {
        guard let panel, panel.isVisible else { return }
        panel.parent?.removeChildWindow(panel)
        panel.orderOut(nil)
        query = nil
        windowObservers.forEach { NotificationCenter.default.removeObserver($0) }
        windowObservers = []
    }

    private func makePanel() -> ComboPanel {
        let panel = ComboPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.isReleasedWhenClosed = false
        // closing is the window observers' job (`observe`): hiding on
        // deactivation would bring a stale list back with the app
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .none
        panel.collectionBehavior = [.transient, .ignoresCycle]

        let effect = NSVisualEffectView()
        effect.material = .popover
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.wantsLayer = true
        effect.layer?.cornerRadius = 9
        effect.layer?.cornerCurve = .continuous
        effect.layer?.masksToBounds = true

        let hosting = FirstClickHostingView(rootView: list)
        hosting.autoresizingMask = []
        effect.addSubview(hosting)
        panel.contentView = effect
        self.panel = panel
        self.hosting = hosting
        return panel
    }

    /// A window move, resize or loss of the keyboard leaves the list behind.
    private func observe(_ window: NSWindow) {
        let center = NotificationCenter.default
        for name in [NSWindow.didResizeNotification, NSWindow.didResignKeyNotification, NSWindow.willCloseNotification] {
            windowObservers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.close() }
            })
        }
    }

    private var width: CGFloat {
        // the chrome around the text: its leading padding, and the chip beside it
        let field = (view?.bounds.width ?? 0) + 7
        return max(field, 380)
    }

    private var list: ComboList {
        ComboList(
            content: content,
            rows: rows,
            query: query,
            highlighted: highlighted,
            opened: opened,
            width: width,
            pick: { [weak self] id in self?.pick(id) },
            refresh: { [weak self] in self?.parent.refresh() }
        )
    }

    /// Hands the list its current state and fits the panel under the field —
    /// above it when the screen ends first.
    private func render() {
        guard let view, let window = view.window, let panel, let hosting else { return }
        hosting.rootView = list
        let size = hosting.fittingSize
        let anchor = window.convertToScreen(view.convert(view.bounds, to: nil))
        let screen = (window.screen ?? NSScreen.main)?.visibleFrame ?? .infinite
        var origin = NSPoint(x: anchor.minX - 7, y: anchor.minY - 5 - size.height)
        if origin.y < screen.minY { origin.y = anchor.maxY + 5 }
        origin.x = min(max(origin.x, screen.minX + 4), screen.maxX - size.width - 4)
        panel.setFrame(NSRect(origin: origin, size: size), display: false)
        // after the window: resizing it first would stretch the list again
        hosting.frame = panel.contentView?.bounds ?? NSRect(origin: .zero, size: size)
        panel.display()
    }
}

/// What the panel shows: a count and where the list came from, the rows, and
/// what the service said about them.
struct ComboList: View {
    let content: ComboContent
    let rows: [ComboRow]
    let query: String?
    let highlighted: String?
    let opened: Int
    let width: CGFloat
    let pick: (String) -> Void
    let refresh: () -> Void

    private static let rowHeight: CGFloat = 26
    private static let visibleRows = 9

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.6)
            if rows.isEmpty {
                Text(emptyMessage)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(rows) { row in
                                rowView(row).id(row.id)
                            }
                        }
                        .padding(4)
                    }
                    // explicit, because a ScrollView has no ideal height and
                    // the panel is sized to what this reports
                    .frame(height: CGFloat(min(rows.count, Self.visibleRows)) * Self.rowHeight + 8)
                    .onChange(of: highlighted) { _, id in
                        if let id { proxy.scrollTo(id) }
                    }
                    .onChange(of: opened) { _, _ in
                        proxy.scrollTo(highlighted ?? rows.first?.id ?? "", anchor: .center)
                    }
                }
            }
            if !footer.isEmpty {
                Divider().opacity(0.6)
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(footer, id: \.text) { line in
                        Text(line.text)
                            .font(.caption2)
                            .foregroundStyle(line.bad ? Color.knodeBad : Color.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
        }
        .frame(width: width, alignment: .leading)
    }

    private var models: Int { content.options.count }

    private var header: some View {
        HStack(spacing: 8) {
            Text(count)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            if let source = content.source {
                RouteBadge(label: sourceLabel(source), color: source == "builtin" ? .knodeViolet : .knodeCyan)
            }
            Spacer(minLength: 8)
            if content.loading { ProgressView().controlSize(.small) }
            Button(action: refresh) {
                Image(systemName: "arrow.clockwise").font(.system(size: 11, weight: .semibold))
            }
            .buttonStyle(.borderless)
            .disabled(content.loading)
            .help(L("Ask the provider again"))
        }
        .padding(.horizontal, 12)
        .frame(height: 32)
    }

    private var count: String {
        if models == 0 { return content.loading ? L("Asking the provider…") : L("No list") }
        guard let query, !query.trimmingCharacters(in: .whitespaces).isEmpty else { return L("%@ models", String(models)) }
        return L("%@ of %@ models", String(rows.count), String(models))
    }

    private var emptyMessage: String {
        if let query, !query.isEmpty { return L("Nothing matches “%@” — ↩ keeps it as typed.", query) }
        if content.loading { return L("Asking the provider…") }
        return L("This provider lists no models — type the id you want.")
    }

    @ViewBuilder
    private func rowView(_ row: ComboRow) -> some View {
        let isHighlighted = row.id == highlighted
        Button { pick(row.id) } label: {
            HStack(spacing: 8) {
                switch row {
                case .empty(let title):
                    Image(systemName: "arrow.uturn.backward")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                    Text(title)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 6)
                case .option(let option):
                    matched(option.id)
                        .font(.system(size: 12, design: .monospaced))
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let label = shownLabel(option) {
                        Text(label)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 6)
                    if let range = effortRange(option) {
                        Text(range).font(.caption2).foregroundStyle(.tertiary).lineLimit(1).fixedSize()
                    }
                    if option.speeds?.contains(where: { $0.id == "fast" }) == true {
                        Image(systemName: "bolt.fill").font(.system(size: 8)).foregroundStyle(.tertiary)
                    }
                }
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.knodeCyan)
                    .opacity(row.id == content.text ? 1 : 0)
            }
            .padding(.horizontal, 8)
            .frame(height: Self.rowHeight)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                isHighlighted ? Color.accentColor.opacity(0.28) : Color.clear,
                in: RoundedRectangle(cornerRadius: 5, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    /// The id with what was typed in bold, so a prefix search shows why a row is there.
    private func matched(_ id: String) -> Text {
        guard let query = query?.trimmingCharacters(in: .whitespaces), !query.isEmpty,
              let range = id.range(of: query, options: .caseInsensitive) else { return Text(id) }
        return Text(id[..<range.lowerBound]) + Text(id[range]).bold().foregroundColor(.knodeCyan) + Text(id[range.upperBound...])
    }

    /// A name that only restates the id ("GPT-6.1-Sol" for gpt-6.1-sol) is left out.
    private func shownLabel(_ option: ModelOption) -> String? {
        guard let label = option.label?.trimmingCharacters(in: .whitespaces), !label.isEmpty,
              label.lowercased() != option.id.lowercased() else { return nil }
        return label
    }

    /// "Low–Ultra": what the chip will offer once this model is picked.
    private func effortRange(_ option: ModelOption) -> String? {
        guard let efforts = option.efforts, let first = efforts.first, let last = efforts.last else { return nil }
        return first.id == last.id ? EffortLevel.name(first.id) : "\(EffortLevel.name(first.id))–\(EffortLevel.name(last.id))"
    }

    private var footer: [(text: String, bad: Bool)] {
        var lines: [(text: String, bad: Bool)] = []
        if let failure = content.failure { lines.append((failure, true)) }
        if let at = content.cachedAt { lines.append((L("Cached — the service last asked at %@.", shortTime(at)), false)) }
        if let note = content.note { lines.append((note, false)) }
        return lines
    }

    /// Just the clock time: the date is never useful for a list minutes old.
    /// The service writes milliseconds, which the default formatter refuses.
    private func shortTime(_ iso: String) -> String {
        let precise = ISO8601DateFormatter()
        precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = precise.date(from: iso) ?? ISO8601DateFormatter().date(from: iso) else { return iso }
        return date.formatted(date: .omitted, time: .standard)
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case "api": L("from the endpoint")
        case "cli": L("from the CLI")
        default: L("suggestions")
        }
    }
}
