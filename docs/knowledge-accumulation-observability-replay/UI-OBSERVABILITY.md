# Brain Knowledge-Accumulation Observability View

## Integration

The existing Brain administration interface (`/admin/brain`) now has a **Knowledge** button in the header. It opens a full-stage observability panel with a vibrant dark card layout and a gradient fresh/replay/validation token bar.

Files:

- `src/admin/public/brain/knowledge.js` — pull-only renderer and refresh controller.
- `src/admin/public/brain/index.html` — Knowledge button and panel.
- `src/admin/public/brain/brain.css` — card, token-mix, history and responsive styles.
- `src/admin/routes.js` — `GET /api/admin/knowledge-accumulation`.
- `src/admin/knowledge-accumulation.js` — read-only telemetry assembly.
- `src/admin/python-store.js` — exposes working/last-good pointers and optimizer metadata.
- `src/training/validation-status.js` — calculated prospective-validation availability.
- `src/training/exposure.js` — shared durable exposure reconstruction.

## Data shown

- Stable serving checkpoint and promotion history.
- Working checkpoint and last-known-good.
- Working advancement/rejection history from the durable training-contribution ledger.
- Optimizer mode, parent, carry-from, completed steps and state-file presence.
- Fresh/replay/validation token proportions, measured replay share, configured target and pre-partition estimate.
- Training steps, planned steps, presented tokens, wall time and throughput.
- Prospective validation availability and the trainer's authoritative block count.
- Working guard groups, negative/over-tolerance counts, worst group.
- Cumulative drift and rollback status.
- Current lifecycle/job waiting reason and learning/training phases.
- Stable decision and explanation.

Each card labels its evidence source as `current`, `historical`, `measured`, `calculated` or `metadata`. Missing values render as `—`; no value is invented.

## Pull-only design

- One `fetch("/api/admin/knowledge-accumulation")` on open and on explicit **Refresh**.
- No `EventSource`.
- No `setInterval` or recurring timer.
- No writes, no RUN/REVIEW lock, no training or acquisition calls.
- The endpoint reads in-process stores/registry, Python store pointers/train-state metadata, the durable contribution ledger, the current job supervisor snapshot, and the read-only validation evaluator.

The test suite asserts that the module contains neither `EventSource` nor `setInterval`.

## Visual evidence

Production telemetry snapshot: 2026-11-04T19:02:24Z, active `v493`, working `v500`, last-good `v499`.

- [`ui-evidence/knowledge-accumulation-view.png`](./ui-evidence/knowledge-accumulation-view.png) — rendered visual evidence from the production telemetry snapshot.
- [`ui-evidence/knowledge-accumulation-preview.html`](./ui-evidence/knowledge-accumulation-preview.html) — self-contained output of the real `renderKnowledge` function with the production snapshot and Brain CSS.

The PNG is a rendered evidence image generated from the same production JSON, not a fabricated mock: it shows the measured `run-425` corpus mix, the actual waiting state, the real guard counts and the real advancement history. The environment had no working headless browser screenshot path, so the self-contained HTML preview is provided alongside the rendered PNG.

## Test evidence

- Renderer test verifies stable/working/last-good, optimizer `carried`, measured 36.7% replay, validation waiting reason and guard explanation.
- Missing telemetry test verifies `—`/unavailable output rather than fabricated values.
- Source test verifies no SSE and no timer.
