---
paths:
  - "tests/**"
  - "src/**/*.test.ts"
  - "package.json"
  - "Dockerfile"
  - "docker-compose.yml"
  - "server.ts"
  - "src/**"
---

# Testing rules

- Characterize existing behavior before refactoring it.
- Add regression tests for every corrected bug and security boundary.
- Prefer unit tests for pure matching/fusion/grouping policy and black-box integration tests for route behavior.
- Test agents should not refactor production code unless explicitly assigned.
- Use Docker as the reproducible gate because the host checkout may not contain dependencies.

Required commands when applicable:

```bash
docker compose --profile test build tests
docker compose --profile test run --rm tests
docker compose --profile test run --rm --entrypoint npm tests run lint
docker compose --profile test run --rm --entrypoint npm tests run build
```

- Integration tests must use an isolated database/container and must never mutate live production data.
- Report exact commands, exit status, pass/fail/skip counts, and known omissions.
- A build-only pass does not replace tests; unit-only tests do not replace integration coverage for route or persistence changes.
