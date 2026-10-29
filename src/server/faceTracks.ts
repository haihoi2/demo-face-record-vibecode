/**
 * Which observations of one gate scan belong to the same face (Taiga #506).
 *
 * A scan looks at a few frames per stream, a fraction of a second apart. With
 * two people at the gate their observations used to be fused as ONE decision:
 * two registered employees side by side came out "ambiguous" and both were
 * refused. Grouping the observations into face tracks lets each face get its
 * own decision under the unchanged fusion rules.
 *
 * Tracks never cross streams (different cameras, different pixel spaces). In a
 * frame, each face joins the nearest track of the same stream whose last box is
 * close (centre distance below `maxCentreShift` face widths) and of a similar
 * size, at most one face per track per frame; otherwise it starts a new track.
 * Two people side by side are more than a face width apart, so they stay apart.
 */
export interface TrackItem {
  streamId: string;
  frameIndex: number;
  /** [x1, y1, x2, y2] in the frame's pixels. */
  box: [number, number, number, number];
}

export interface FaceTrackOptions {
  /** Max centre distance between frames, in face widths. */
  maxCentreShift: number;
  /** Max ratio between the larger and smaller face width. */
  maxSizeRatio: number;
}

export const DEFAULT_FACE_TRACK_OPTIONS: FaceTrackOptions = { maxCentreShift: 0.8, maxSizeRatio: 1.8 };

/** Track number per item (index-parallel to `items`), numbered from 0 in first-seen order. */
export function groupFaceTracks(items: TrackItem[], options: Partial<FaceTrackOptions> = {}): number[] {
  const opt = { ...DEFAULT_FACE_TRACK_OPTIONS, ...options };
  const out = new Array<number>(items.length).fill(-1);
  const tracks: Array<{ streamId: string; box: TrackItem["box"]; frameIndex: number }> = [];

  const order = items.map((_, i) => i).sort((a, b) => {
    const sa = items[a].streamId, sb = items[b].streamId;
    if (sa !== sb) return sa < sb ? -1 : 1;
    return items[a].frameIndex - items[b].frameIndex || a - b;
  });

  let i = 0;
  while (i < order.length) {
    // One frame of one stream at a time.
    const first = items[order[i]];
    const frame: number[] = [];
    while (i < order.length && items[order[i]].streamId === first.streamId && items[order[i]].frameIndex === first.frameIndex) {
      frame.push(order[i]);
      i += 1;
    }
    // Every (face, track) pair close enough, nearest first.
    const pairs: Array<{ item: number; track: number; d: number }> = [];
    for (const item of frame) {
      const b = items[item].box;
      for (let t = 0; t < tracks.length; t++) {
        const tr = tracks[t];
        if (tr.streamId !== first.streamId || tr.frameIndex >= first.frameIndex) continue;
        const d = shift(b, tr.box);
        if (d <= opt.maxCentreShift && sizeRatio(b, tr.box) <= opt.maxSizeRatio) pairs.push({ item, track: t, d });
      }
    }
    pairs.sort((a, b) => a.d - b.d);
    const takenTracks = new Set<number>();
    for (const p of pairs) {
      if (out[p.item] >= 0 || takenTracks.has(p.track)) continue;
      out[p.item] = p.track;
      takenTracks.add(p.track);
    }
    for (const item of frame) {
      if (out[item] < 0) {
        tracks.push({ streamId: first.streamId, box: items[item].box, frameIndex: first.frameIndex });
        out[item] = tracks.length - 1;
      } else {
        tracks[out[item]].box = items[item].box;
        tracks[out[item]].frameIndex = first.frameIndex;
      }
    }
  }
  return out;
}

function width(b: TrackItem["box"]): number {
  return Math.max(1, b[2] - b[0]);
}

/** Centre distance in widths of the larger face. */
function shift(a: TrackItem["box"], b: TrackItem["box"]): number {
  const dx = (a[0] + a[2]) / 2 - (b[0] + b[2]) / 2;
  const dy = (a[1] + a[3]) / 2 - (b[1] + b[3]) / 2;
  return Math.hypot(dx, dy) / Math.max(width(a), width(b));
}

function sizeRatio(a: TrackItem["box"], b: TrackItem["box"]): number {
  const wa = width(a), wb = width(b);
  return Math.max(wa, wb) / Math.min(wa, wb);
}
