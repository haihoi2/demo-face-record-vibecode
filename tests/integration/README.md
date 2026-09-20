# Integration regression suite

Black-box HTTP tests against a **running** gateway. They use Node's built-in
`node:test` runner and global `fetch`; no extra dependencies.

They exist mainly to keep the three door-unlock bypasses fixed in commit
`420c192` closed for good (`security.test.ts`), plus coverage of the
stranger-cluster endpoints (`strangers.test.ts`) and the CORS allowlist
(`cors.test.ts`). Every test is independent and re-runnable; the only roster
change is a temporary employee that the suite creates and deletes itself.

Target URL: `APP_URL` (default `http://127.0.0.1:3100`).
Never point this at the shared staging instance on `:8080` - the lock tests
call `/api/lock/lock` and post frames to `/api/recognize-face`.

## 1. Start a disposable smoke server

The server binds `3000` inside the container regardless of `PORT`, so publish
`3100:3000`. SQLite mode (`DATABASE_URL=` empty) needs no database.

```sh
docker compose --profile test run --rm -d --name smartface-itest \
  -e DATABASE_URL= -e DATA_DIR=/tmp/data \
  -e ALLOW_SIMULATED_RECOGNITION=false \
  -e CORS_ALLOWED_ORIGINS=http://allowed.test \
  -p 3100:3000 --entrypoint sh tests -c 'npx tsx server.ts'

until curl -sf http://127.0.0.1:3100/api/health; do sleep 1; done
```

`ALLOW_SIMULATED_RECOGNITION` must be unset or `false` and no real
`GEMINI_API_KEY` should be set. `CORS_ALLOWED_ORIGINS` must contain the origin
the CORS suite uses (`CORS_TEST_ALLOWED_ORIGIN`, default `http://allowed.test`).

## 2. Run the suite

From another container on the same compose network (the smoke container is
reachable by its name on port 3000):

```sh
docker compose --profile test run --rm --build \
  -e APP_URL=http://smartface-itest:3000 \
  --entrypoint sh tests -c 'npm run test:integration'
```

Or from a checkout with `node_modules` installed:

```sh
APP_URL=http://127.0.0.1:3100 npm run test:integration
```

## 3. Clean up

```sh
docker rm -f smartface-itest
```

## Notes

- The unit suite (`npm test`, glob `tests/*.test.ts`) does not pick these
  files up; they live one directory deeper and are only matched by
  `tests/integration/*.test.ts`.
- `helpers.ts` builds the "no face" probe image in code: a tiny baseline JPEG
  of a flat grey square, sent as `data:image/jpeg;base64,...`.
