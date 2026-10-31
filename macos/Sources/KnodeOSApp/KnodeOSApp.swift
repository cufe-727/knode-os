import AppKit
import SwiftUI

@main
struct KnodeOSApp: App {
    @StateObject private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .preferredColorScheme(.dark)
                .frame(minWidth: 980, minHeight: 660)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    model.shutdown()
                }
        }
        .defaultSize(width: 1320, height: 820)
        .commands {
            CommandMenu("Navigate") {
                // the field above every screen: search, ask or research from anywhere
                Button(L("Search, Ask or Research…")) { model.focusTopSearch() }
                    .keyboardShortcut("k", modifiers: .command)
                    .disabled(model.phase != .app)
                Divider()
                // ⌘1…⌘5 pick a section (landing on the tab it was left at);
                // ⌘⇧1… pick a tab inside the section already showing.
                ForEach(Array(AppSection.allCases.enumerated()), id: \.element.id) { index, section in
                    Button(section.title) { model.select(section: section) }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                        .disabled(model.phase != .app)
                }
                Divider()
                ForEach(Array(model.selectedSection.tabs.enumerated()), id: \.element.id) { index, tab in
                    Button(tab.title) { model.select(tab) }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: [.command, .shift])
                        .disabled(model.phase != .app || model.selectedSection.tabs.count < 2)
                }
            }
            CommandGroup(after: .sidebar) {
                Button("Refresh Workspace") {
                    model.workspaceRevision += 1
                    Task { await model.refreshStats() }
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(model.phase != .app)
            }
        }
    }
}
