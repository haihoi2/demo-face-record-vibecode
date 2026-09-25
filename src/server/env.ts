/**
 * Numeric settings from the environment.
 *
 * docker-compose passes an unset variable through as an EMPTY string
 * (`FOO=${FOO:-}`), and Number("") is 0 - a finite, often in-range value. Read
 * naively, "not configured" silently became "configured to zero": on staging
 * that switched the stranger quality floor off. Blank now means unset.
 */
export function envNumber(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; integer?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  if (opts.integer && !Number.isInteger(v)) return fallback;
  if (opts.min !== undefined && v < opts.min) return fallback;
  if (opts.max !== undefined && v > opts.max) return fallback;
  return v;
}
