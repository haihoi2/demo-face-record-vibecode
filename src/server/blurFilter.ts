/**
 * Blur filter (Taiga #511, S1 of docs/plans/2026-10-07-face-sharpness.md;
 * evaluation and numbers in docs/plans/2026-11-03-blur-filter.md).
 *
 * Pure. Decides from the metrics ALREADY stored with every face whether a
 * capture is too blurred to show in the stranger panel or to use as a template.
 * Never a door decision: access policy does not call this.
 *
 * Capture quality is not liveness: nothing here says anything about
 * presentation attacks, only about how much detail the capture carries.
 *
 * Fail-safe direction: a missing or incompatible metric gives `null`, and
 * `isBlurry` answers false for `null` - we never hide a capture on unknowns.
 */

/** featureNorm is the recogniser's pre-normalisation feature strength: it is only comparable within one model. */
export const BLUR_MODEL_TAG = "arcface_w600k_r50";

export interface BlurMetrics {
  /** faceEdgeEnergy() of the aligned 112x112 face (contrast-normalised gradient energy). */
  edgeEnergy?: number | null;
  /** ArcFace feature strength before L2 normalisation; model-specific (BLUR_MODEL_TAG). */
  featureNorm?: number | null;
  /** Shorter side of the face box in source pixels. */
  sizePx?: number | null;
  /** Model tag the featureNorm came from; when given it must equal policy.featureNormModelTag. */
  modelTag?: string | null;
}

export interface BlurPolicy {
  /** Logistic model: logit(blurry) = intercept + wEdge*edgeEnergy + wFeatureNorm*featureNorm + wLnSize*ln(sizePx). */
  intercept: number;
  wEdge: number;
  wFeatureNorm: number;
  wLnSize: number;
  /** A face is blurry when sharpness (= -logit) < threshold. */
  threshold: number;
  featureNormModelTag: string;
}

/**
 * DEFAULT: logistic fit on this site's own labels (scripts/perf/blur-label-eval.ts,
 * 2026-11-02; full tables in docs/plans/2026-11-03-blur-filter.md).
 *
 * Labels: 232 blurry (230 "Báo ảnh mờ" + rated-blurry, two actors, 2026-10-07..
 * 10-23) vs 2718 sharp (5 rated-sharp + 2713 recognised with cosine >= 0.65),
 * entry 138/1671, exit 94/1047. All on arcface_w600k_r50.
 *
 * What the stored metrics can do (pooled ROC AUC, sharp vs blurry):
 *   edgeEnergy 0.55   quality 0.54   detectorScore 0.53   sizePx 0.54  (no signal)
 *   featureNorm 0.78  featureNorm + ln(sizePx) 0.81 (5-fold CV 0.80)
 *   adding edgeEnergy or quality to that: 0.80-0.81, no gain -> left out.
 * featureNorm separates best on small faces (AUC 0.90 at 60-79 px, 0.72 at >= 110 px),
 * which is why the size term matters: a small face must have a higher featureNorm.
 *
 * Operating points of this model (pooled): catching 95 % of blurry would lose
 * 60 % of sharp; catching 70 % loses 24 %. The threshold below is the plan's
 * budget of <= 10 % sharp lost: it catches 44.8 % of the blurry labels
 * (entry 44 %, exit 52 %) and loses 10 % of sharp (entry 10 %, exit 10 %).
 * The S3 target (>= 70 % removed at <= 10 % lost) is NOT reached by any stored
 * metric; see the plan for what that means for rollout (shadow first).
 *
 * In featureNorm terms: blurry when featureNorm < (19.14 - 1.3364 ln(sizePx)) / 0.5703,
 * i.e. < 23.7 at 66 px, < 22.8 at 100 px, < 21.8 at 150 px, < 21.0 at 220 px.
 * The current stranger floor (featureNorm < 20) catches 0 % of the labels.
 */
export const DEFAULT_BLUR_POLICY: BlurPolicy = {
  intercept: 17.4616,
  wEdge: 0,
  wFeatureNorm: -0.5703,
  wLnSize: -1.3364,
  threshold: 1.68,
  featureNormModelTag: BLUR_MODEL_TAG,
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Sharpness score (higher = sharper), or null when a metric the policy
 * weights is missing, non-finite, non-positive where it must be positive, or
 * the featureNorm comes from another model.
 */
export function blurSharpness(m: BlurMetrics | null | undefined, policy: BlurPolicy = DEFAULT_BLUR_POLICY): number | null {
  if (!m) return null;
  if (!finite(m.featureNorm) || m.featureNorm <= 0) return null;
  if (m.modelTag != null && m.modelTag !== policy.featureNormModelTag) return null;
  let logit = policy.intercept + policy.wFeatureNorm * m.featureNorm;
  // Terms with weight 0 do not require their metric (the default ignores edgeEnergy).
  if (policy.wEdge !== 0) {
    if (!finite(m.edgeEnergy) || m.edgeEnergy < 0) return null;
    logit += policy.wEdge * m.edgeEnergy;
  }
  if (policy.wLnSize !== 0) {
    if (!finite(m.sizePx) || m.sizePx <= 0) return null;
    logit += policy.wLnSize * Math.log(m.sizePx);
  }
  return Number.isFinite(logit) ? -logit : null;
}

/** P(blurry) in 0..1 for display/shadow logging, or null when the score is unavailable. */
export function blurProbability(m: BlurMetrics | null | undefined, policy: BlurPolicy = DEFAULT_BLUR_POLICY): number | null {
  const s = blurSharpness(m, policy);
  return s === null ? null : 1 / (1 + Math.exp(s));
}

/** true only when the score is available AND below the policy threshold. Unknown -> false. */
export function isBlurry(m: BlurMetrics | null | undefined, policy: BlurPolicy = DEFAULT_BLUR_POLICY): boolean {
  const s = blurSharpness(m, policy);
  return s !== null && s < policy.threshold;
}

/**
 * What the integrator wires (server.ts, behind FACE_BLUR_FILTER=off|shadow|hide|enforce):
 *  - hideFromClusters: faces with isBlurry() are not grouped/shown in the
 *    stranger cluster panel (kept in the access history, restorable);
 *  - refuseAsTemplate: isBlurry() captures are not accepted as enrolment,
 *    merge or camera-adaptation templates.
 * Returns the policy pieces so call sites read one source of truth.
 */
export function proposedFloors(policy: BlurPolicy = DEFAULT_BLUR_POLICY) {
  return {
    hideFromClusters: (m: BlurMetrics | null | undefined) => isBlurry(m, policy),
    refuseAsTemplate: (m: BlurMetrics | null | undefined) => isBlurry(m, policy),
    policy: { ...policy },
  };
}

/** Parse FACE_BLUR_FILTER / FACE_BLUR_THRESHOLD style overrides into a policy; invalid values keep the default. */
export function blurPolicyFromEnv(env: Record<string, string | undefined>, base: BlurPolicy = DEFAULT_BLUR_POLICY): BlurPolicy {
  const t = Number(env.FACE_BLUR_THRESHOLD);
  return Number.isFinite(t) && env.FACE_BLUR_THRESHOLD !== undefined && env.FACE_BLUR_THRESHOLD !== "" ? { ...base, threshold: t } : { ...base };
}
