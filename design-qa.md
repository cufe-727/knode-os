# macOS Design QA

## Comparison target

- Source visual truth: the running Web UI at `http://127.0.0.1:9100/` on 2026-07-19.
- Reference state: admin, Personal workspace, Files, `wiki/index.md`, dark appearance.
- Source screenshot: `macos/qa/web-files-reference.jpg` (1280 × 720).
- Native screenshot: `macos/qa/native-files.jpg` (1237 × 768; compared with a 1237 × 720 top crop).
- Side-by-side comparison: `macos/qa/files-comparison.png`.
- Additional native evidence: `macos/qa/native-graph.jpg` and `macos/qa/native-settings.jpg`.

## Full-view comparison

The Web UI and native app were inspected together in the same Personal / Files / `wiki/index.md` state. The native app deliberately translates the Web top-tab shell into a persistent macOS sidebar while preserving the same information architecture, dark visual language, workspace identity, corpus metrics, file hierarchy, document path, Markdown content, and primary actions.

- Typography: hierarchy matches the source intent—large bold document headings, compact semibold navigation, muted secondary copy, and monospaced metadata/statistics. Native system type is used for platform fidelity.
- Layout rhythm: the native sidebar, file outline, and document pane remain clearly separated with consistent 12–20 pt spacing. No cropped controls, accidental overflow, or broken alignment was found at the tested window size.
- Color/tokens: near-black surfaces, subtle separators, cyan links/status, violet knowledge accents, and blue macOS selection states remain coherent with the Web UI.
- Asset fidelity: the bundled app uses the repository's real `favicon.svg`; action and navigation icons use SF Symbols with semantic labels. No placeholder or improvised visible assets remain.
- Copy/content: workspace labels, metrics, file path, metadata, Index heading, navigation description, and six linked bullets match the Web state.

## Focused comparisons

- Sign-in and workspace choice: rendered successfully; split onboarding layout, source logo, endpoint field, credentials form, Personal card, and Join Team controls were present and accessible.
- Files: metadata front matter renders as a dedicated card, Markdown headings/lists/links retain structure, editor/preview mode switches correctly, and writable-root restrictions disable destructive actions for protected files.
- Search and Ask: hybrid search returned ten results; opening a result navigated to its file. Ask returned an answer with a citation; selecting the citation navigated to `purpose.md`.
- Graph: seven nodes and fifteen relations rendered without clipping. Entity selection, legend, depth control, Explore, and the Insights sheet were available; the sheet reported seven entities, fifteen relations, seven mentions, hubs, entity types, and one isolated entity.
- Traces and Dream: empty states, filters/status controls, and primary actions rendered cleanly without overflow.
- Settings: route summary, embedding configuration, extraction/synthesis routes, pipeline controls, protected API-key field, and default-model disclosure remained legible through the full scroll range.
- Workspace/navigation: the account menu exposed Personal, Join another Team, and Sign out. `Command-2` navigated to Search and focused the query field.

## Findings

- [Resolved P1] Markdown preview flattened block structure.
  - Evidence: the first native Files capture displayed front matter, heading, paragraph, and list as one text run.
  - Fix: replaced the single attributed-text renderer with a block-aware Markdown renderer supporting front matter, headings, paragraphs, lists, quotes, fenced code, rules, and inline Markdown.
  - Verification: `macos/qa/files-comparison.png` shows the corrected hierarchy and link treatment.
- [Resolved P2] File tree stayed empty when the service became available after app launch.
  - Fix: Files now reloads its initial tree when connection state changes to connected.
  - Verification: after rebuilding and relaunching with the service running, the tree and `wiki/index.md` loaded without a manual refresh.
- [P3] Restored/opened files do not automatically expand their ancestor folder in the outline.
  - Location: Files sidebar after relaunch or cross-feature navigation.
  - Impact: the path and content are correct, but the active row can be outside the visible collapsed branch.
  - Follow-up: persist outline expansion state or expand ancestors when `selectedFilePath` changes.

## Interaction and accessibility verification

- Completed sign-in with local mock credentials and selected the Personal workspace.
- Exercised service recovery, file refresh/expand/open, preview/edit switching, hybrid search, result-to-file navigation, Ask citation navigation, graph insights, workspace menu, and keyboard navigation.
- Verified Traces, Dream, and Settings empty/configuration states without triggering write-heavy or externally billed actions.
- The native accessibility tree exposed named rows, fields, buttons, menus, radio groups, checkboxes, sheets, and toolbar content throughout the tested flows.
- The Web reference produced no warning or error console entries during the capture pass; the native app remained responsive and did not crash.

## Comparison history

- Pass 1: blocked by the locked Mac session; no speculative visual conclusions were made.
- Pass 2: unlocked rendered inspection found the P1 Markdown issue and P2 connection-recovery issue.
- Pass 3: both fixes were rebuilt, repackaged, and re-tested. The side-by-side Files comparison plus Graph, Traces, Dream, Settings, menu, and keyboard checks found no remaining P0/P1/P2 issues.

## Follow-up polish

- P3: reveal the active file by automatically expanding its ancestor folder.

final result: passed
