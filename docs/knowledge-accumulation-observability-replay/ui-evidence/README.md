# UI Evidence

`knowledge-accumulation-view.png` is rendered from the production telemetry snapshot in `../evidence/knowledge-accumulation-observability.json` (2026-11-04T19:02:24Z). It shows actual stable/working/last-good versions, the measured `run-425` corpus mix, the waiting validation state, the working guard counts and the durable advancement history.

`knowledge-accumulation-preview.html` is self-contained output from the real `renderKnowledge()` function using the same production JSON and Brain CSS. Open it in a browser to inspect the exact implemented layout without starting the service or opening an SSE stream.

The environment did not expose a working headless-browser screenshot path; the PNG is therefore a rendered evidence image generated from the production JSON rather than a browser-controlled screenshot.
