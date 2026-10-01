import { gateEnvSuffix, isGateId } from "../gates";
import type { Gate, PipelineMode } from "./contracts";

const MODES: readonly PipelineMode[] = ["legacy", "shadow", "live"];

/**
 * PIPELINE_MODE_<SUFFIX> of a gate id (gateEnvSuffix): PIPELINE_MODE_ENTRY for
 * "entry" and PIPELINE_MODE_EXIT for "exit" (the legacy names, unchanged),
 * PIPELINE_MODE_SIDE_DOOR for "side-door". Anything else (blank, typo) is
 * `legacy`: the new pipeline only runs when asked for by name. A value that is
 * not a gate id (e.g. the old direction "ENTRY") is refused: always `legacy`,
 * never read under another gate's name.
 */
export function pipelineModeFromEnv(gate: Gate, env: Record<string, string | undefined> = process.env): PipelineMode {
  if (!isGateId(gate)) return "legacy";
  return parsePipelineMode(env[`PIPELINE_MODE_${gateEnvSuffix(gate)}`]) ?? "legacy";
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
