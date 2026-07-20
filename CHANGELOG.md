# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] - 2026-07-20

### Added
- `fork(symbol)`: a tenth `StageKind` for runtime-sized fan-out of one symbol over a flowing array.
- `abort(value, desc?)` / `fail(error, desc?)`: optional human-readable termination reason, surfaced on `Verb` and threaded into `TraceEntry.desc`.

### Changed
- `invoke()` no longer lets a throwing trace sink mask a handler's own result or error.
- `fork()`/`spawn()` validate branch meta and reject duck-typed branches with a diagnostic `TypeError`.

### Removed
- `BranchArity`, `fixedArity`, `runtimeArity` (superseded by `fork(symbol)`).

### Docs
- Restructured fork docs around static/dynamic vocabularies; documented `BufferBuilder` cell-set-vs-cell-sharing semantics.
