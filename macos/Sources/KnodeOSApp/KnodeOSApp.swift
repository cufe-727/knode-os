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
                ForEach(Array(AppSection.allCases.enumerated()), id: \.element.id) { index, section in
                    Button(section.title) { model.selectedSection = section }
                        .keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
                        .disabled(model.phase != .app)
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
