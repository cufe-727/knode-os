# knode-os for macOS

The native client keeps the Web UI's capability model while using macOS navigation conventions.

## Product structure

- A persistent source-list sidebar replaces the browser tab strip. Its five sections follow docs/design/20: Library (Files), Explore (Search, Ask, Research), Knowledge (Graph, Entities, Wiki), Tasks (Queue, Dream) and Settings; ⌘1…⌘5 pick them.
- One search field sits in the toolbar's centre above every screen (⌘K). As you type it offers Search, Ask and Research of the text, then entities and documents by name, in a panel drawn in the window rather than a popover, which would take the field's focus.
- Explore → Search explains itself: each passage's rank in the semantic, keyword and entity channels, and beside the passages the entities the query names, their relations and the claims about them.
- Tasks → Queue shows what runs: processing and its switch (Start shows the estimate first), the pipeline by stage, the calls in flight, workers, jobs, background work and the schedule. The toolbar keeps only a status pill that opens it.
- Files uses a nested split view: source tree on the left, preview/editor on the right. Its Import menu brings material in: files or a folder uploaded, a folder of the service's machine linked and kept in sync, agent traces.
- The source tree holds knowledge only. The service leaves the ledger, lint reports, dataset pages and playbooks out of it, and each folder knode-os makes carries a one-line description.
- What those folders used to tell you arrives as notices behind a toolbar button: lint findings, trace collection waiting for a yes, an unwritten purpose.md, an uninitialized wiki, failing datasources. Playbooks are edited under Settings → Playbooks.
- Search, citations, graph grounding, and Dream reports all deep-link back to Files.
- Personal and Team workspaces remain isolated through the same request headers as the Web UI.
- Long-running operations expose progress in the toolbar or local content area and never freeze navigation.

## Visual language

- Dark appearance, cyan primary accent, violet secondary accent, and compact monospaced metadata follow the Web UI.
- Native materials, tables, menus, sheets, alerts, SF Symbols, focus rings, and keyboard commands replace browser-specific controls.
- Dense operational screens use 12–16 pt spacing, 8–12 pt corner radii, and a clear content hierarchy rather than decorative panels.

## Capability parity

Files, Search, Ask, Research, Graph, Entities, Wiki, the task queue, Dream and its traces, Settings, local accounts, Personal/Team switching, uploads, ingestion, model route testing, and model route saving all call the existing localhost REST API.
