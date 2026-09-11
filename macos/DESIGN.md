# knode-os for macOS

The native client keeps the Web UI's capability model while using macOS navigation conventions.

## Product structure

- A persistent source-list sidebar replaces the browser tab strip.
- Files uses a nested split view: source tree on the left, preview/editor on the right.
- Search, citations, graph grounding, and Dream reports all deep-link back to Files.
- Personal and Team workspaces remain isolated through the same request headers as the Web UI.
- Long-running operations expose progress in the toolbar or local content area and never freeze navigation.

## Visual language

- Dark appearance, cyan primary accent, violet secondary accent, and compact monospaced metadata follow the Web UI.
- Native materials, tables, menus, sheets, alerts, SF Symbols, focus rings, and keyboard commands replace browser-specific controls.
- Dense operational screens use 12–16 pt spacing, 8–12 pt corner radii, and a clear content hierarchy rather than decorative panels.

## Capability parity

Files, Search, Ask, Graph, Traces, Dream, Settings, local accounts, Personal/Team switching, uploads, ingestion, model route testing, and model route saving all call the existing localhost REST API.
