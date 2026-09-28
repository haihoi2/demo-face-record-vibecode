import type { Gate, PipelineMode } from "./contracts";

const MODES: readonly PipelineMode[] = ["legacy", "shadow", "live"];

/**
 * PIPELINE_MODE_ENTRY / PIPELINE_MODE_EXIT. Anything else (blank, typo) is
 * `legacy`: the new pipeline only runs when asked for by name.
 */
export function pipelineModeFromEnv(gate: Gate, env: Record<string, string | undefined> = process.env): PipelineMode {
  return parsePipelineMode(env[`PIPELINE_MODE_${gate}`]) ?? "legacy";
}

/** A mode name from config or a request body; undefined for anything else. */
export function parsePipelineMode(raw: unknown): PipelineMode | undefined {
  const v = String(raw ?? "").trim().toLowerCase();
  return (MODES as readonly string[]).includes(v) ? (v as PipelineMode) : undefined;
}

/**
 * Modes this build can actually run. Until the pipeline is wired (W2), a gate
 * configured as shadow/live stays on the legacy watcher and says so.
 */
export const IMPLEMENTED_MODES: readonly PipelineMode[] = ["legacy", "shadow"];

export function effectivePipelineMode(requested: PipelineMode): { mode: PipelineMode; downgraded: boolean } {
  return IMPLEMENTED_MODES.includes(requested) ? { mode: requested, downgraded: false } : { mode: "legacy", downgraded: true };
}
