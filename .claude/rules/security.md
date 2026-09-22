# Security rules

- Never reveal or commit credentials from `.env`, deployment files, camera URLs, webhook URLs, door configuration, database configuration, logs, or Git authentication.
- Do not send door-controller tokens or raw face embeddings to the browser.
- Do not trust CORS, browser state, local storage, frontend feature flags, or a LAN address as authorization.
- Require authentication, role authorization, and actor-attributed audit records for sensitive reads and all mutations.
- Validate outbound webhook, camera, RTSP, and door-controller destinations against an explicit backend allowlist; block loopback, link-local, metadata, and unintended private destinations.
- Production door access must fail closed if the real ONNX engine, compatible gallery, or server-owned policy is unavailable.
- Preserve the original access outcome. Stranger merge/promotion creates adjudication and provenance records rather than falsifying historical DENIED events.
- Stranger images, templates, and embeddings are biometric data. Define encryption, access, retention, legal hold, deletion, export, and audit behavior before broadening collection.
- Never run mutating tests against the live service or database.
- Add negative tests for unauthenticated access, authorization, SSRF, malformed payloads, model mismatch, replay/idempotency, and concurrent mutations.
