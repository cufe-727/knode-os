# knode-os for macOS

The native client keeps the Web UI's capability model while using macOS navigation conventions.

## Product structure

- A persistent source-list sidebar replaces the browser tab strip.
- Files uses a nested split view: source tree on the left, preview/editor on the right.
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

Files, Search, Ask, Graph, Traces, Dream, Settings, local accounts, Personal/Team switching, uploads, ingestion, model route testing, and model route saving all call the existing localhost REST API.
