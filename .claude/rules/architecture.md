---
paths:
  - "server.ts"
  - "src/**/*.ts"
  - "src/**/*.tsx"
  - "init-db.sql"
---

# Architecture rules

- Keep the React UI, API routes, domain services, repositories, face engine, and physical-device adapters as distinct boundaries.
- Treat `server.ts` as an integration hotspot. Extract incrementally under characterization tests; do not perform a broad rewrite.
- Keep identity matching separate from access authorization, access-event recording, and door actuation.
- Backend state is authoritative for production recognition, access policy, stranger resolution, and device commands.
- Demo/offline/simulation paths must be visibly labeled and technically unable to open a physical door.
- Centralize SSE ownership instead of adding independent feature subscriptions.
- Introduce shared contracts deliberately. `src/types.ts` has temporary single-writer ownership when changed.
- Do not add cross-layer shortcuts to unblock another agent. Propose contract changes in the handoff and let the owning agent implement them.
