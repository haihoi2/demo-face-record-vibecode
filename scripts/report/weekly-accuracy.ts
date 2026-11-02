#!/usr/bin/env -S npx tsx
/**
 * Weekly recognition-accuracy report (Taiga #505).
 *
 *   npx tsx scripts/report/weekly-accuracy.ts --from 2026-10-27 --to 2026-11-02 \
 *       [--compare-from 2026-10-13 --compare-to 2026-10-26] [--out docs/reports/2026-11-02.md]
 *
 * Dates are LOCAL (Asia/Ho_Chi_Minh) calendar days, inclusive. Reads PostgreSQL
 * read-only through DATABASE_URL, or the libpq PG* variables, or the compose
 * POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB trio (host PGHOST, default
 * "postgres"). Only aggregate numbers are printed: no log ids, names, images or
 * embeddings are read. Without --out the Markdown goes to stdout.
 */

import fs from "node:fs";
import path from "node:path";
import { Client } from "pg";

import {
  localDateRangeToUtc,
  renderReport,
  summarizePeriod,
  type DecisionRow,
  type ResolutionRow,
} from "./weeklyReportHelpers";

interface Args {
  from: string;
  to: string;
  compareFrom?: string;
  compareTo?: string;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i === -1) return undefined;
    const v = argv[i + 1];
    if (!v || v.startsWith("--")) throw new Error(`--${name} needs a value`);
    return v;
  };
  const from = get("from");
  const to = get("to");
  if (!from || !to) {
    throw new Error("Usage: weekly-accuracy.ts --from YYYY-MM-DD --to YYYY-MM-DD [--compare-from YYYY-MM-DD --compare-to YYYY-MM-DD] [--out file.md]");
  }
  const compareFrom = get("compare-from");
  const compareTo = get("compare-to");
  if ((compareFrom && !compareTo) || (!compareFrom && compareTo)) {
    throw new Error("--compare-from and --compare-to must be given together");
  }
  return { from, to, compareFrom, compareTo, out: get("out") };
}

/** Connection settings without ever echoing them. */
function clientConfig(env: NodeJS.ProcessEnv): ConstructorParameters<typeof Client>[0] {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  if (env.PGHOST || env.PGDATABASE || env.PGUSER) return {}; // libpq-style PG* variables are read by `pg` itself
  if (env.POSTGRES_USER && env.POSTGRES_DB) {
    return {
      host: env.POSTGRES_HOST || "postgres",
      port: Number(env.POSTGRES_PORT || 5432),
      user: env.POSTGRES_USER,
      password: env.POSTGRES_PASSWORD,
      database: env.POSTGRES_DB,
    };
  }
  throw new Error("No database settings: set DATABASE_URL, PG* variables, or POSTGRES_USER/POSTGRES_PASSWORD/POSTGRES_DB");
}

async function loadDecisions(client: Client, startIso: string, endIso: string): Promise<DecisionRow[]> {
  const res = await client.query<DecisionRow>(
    `SELECT id, "timestamp", "capturedAt", status, "gateId", reason
       FROM access_logs
      WHERE "timestamp" >= $1 AND "timestamp" < $2`,
    [startIso, endIso],
  );
  return res.rows;
}

async function loadResolutions(client: Client): Promise<ResolutionRow[]> {
  const res = await client.query<ResolutionRow>(`SELECT action, "resolvedAt", "logIds" FROM stranger_resolutions`);
  return res.rows;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const current = localDateRangeToUtc(args.from, args.to);
  const compare = args.compareFrom && args.compareTo ? localDateRangeToUtc(args.compareFrom, args.compareTo) : null;

  const client = new Client(clientConfig(process.env));
  await client.connect();
  let markdown: string;
  try {
    await client.query("SET default_transaction_read_only = on");
    const resolutions = await loadResolutions(client);
    const curRows = await loadDecisions(client, current.startIso, current.endIso);
    const curSummary = summarizePeriod(curRows, resolutions, args.from, args.to);
    let cmpSummary = null;
    if (compare && args.compareFrom && args.compareTo) {
      const cmpRows = await loadDecisions(client, compare.startIso, compare.endIso);
      cmpSummary = summarizePeriod(cmpRows, resolutions, args.compareFrom, args.compareTo);
    }
    markdown = renderReport(curSummary, cmpSummary, { generatedAt: new Date().toISOString() });
  } finally {
    await client.end();
  }

  if (args.out) {
    fs.mkdirSync(path.dirname(args.out), { recursive: true });
    fs.writeFileSync(args.out, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    console.error(`Wrote ${args.out}`);
  } else {
    process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  }
}

main().catch((err) => {
  // Never print connection settings; pg errors do not include them, but keep the message short anyway.
  console.error(`weekly-accuracy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
