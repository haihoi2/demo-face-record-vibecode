import type { Gate, PipelineMode } from "./contracts";

const MODES: readonly PipelineMode[] = ["legacy", "shadow", "live"];

/**
 * PIPELINE_MODE_ENTRY / PIPELINE_MODE_EXIT. Anything else (blank, typo) is
 * `legacy`: the new pipeline only runs when asked for by name.
 */
export function pipelineModeFromEnv(gate: Gate, env: Record<string, string | undefined> = process.env): PipelineMode {
  const raw = String(env[`PIPELINE_MODE_${gate}`] || "").trim().toLowerCase();
  return (MODES as readonly string[]).includes(raw) ? (raw as PipelineMode) : "legacy";
}

/**
 * Modes this build can actually run. Until the pipeline is wired (W2), a gate
 * configured as shadow/live stays on the legacy watcher and says so.
 */
export const IMPLEMENTED_MODES: readonly PipelineMode[] = ["legacy"];

export function effectivePipelineMode(requested: PipelineMode): { mode: PipelineMode; downgraded: boolean } {
  return IMPLEMENTED_MODES.includes(requested) ? { mode: requested, downgraded: false } : { mode: "legacy", downgraded: true };
}
