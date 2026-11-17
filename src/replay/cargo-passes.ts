/**
 * Splitting a cargo plane's recorded track into the separate flights it holds.
 *
 * The engine recycles an aircraft's key once its pass is over, so one track
 * can carry several deliveries end to end. Flown as one, the plane crosses the
 * map and then — instead of leaving — turns round at the edge and flies back
 * the way it came to make the next delivery.
 *
 * The two are cleanly told apart. While a plane is up the stream restates it
 * constantly: half of those gaps are under 132ms and 99% under 1.4s. Every gap
 * that carries the plane more than a few cells sideways is at least 2.1
 * seconds long, which is the key sitting idle between deliveries. Splitting at
 * two seconds ends 112 turnarounds in one reference replay and 56 in another,
 * and leaves genuinely continuous flights untouched — a plane circling its own
 * strip while it waits really does double back, and still does here.
 */
import type { ObjectTrack } from "./object-stream";

/** One reading from a track: where an object was, and when. */
export type TrackSample = ObjectTrack["samples"][number];

/**
 * How long a plane's key can go quiet before the next sighting is a new flight.
 */
export const CARGO_PASS_GAP_MS = 2000;

/**
 * How many readings a run needs before it counts as a delivery.
 *
 * A stray sighting or two either side of a real pass is not one.
 */
const CARGO_PASS_MIN_SAMPLES = 4;

/** One track's flights, in order, each one a run the plane was actually up for. */
export function cargoPasses(track: ObjectTrack): TrackSample[][] {
  const out: TrackSample[][] = [];
  let pass: TrackSample[] = [];
  const end = (): void => {
    if (pass.length >= CARGO_PASS_MIN_SAMPLES) out.push(pass);
    pass = [];
  };
  for (const s of track.samples) {
    if (s.px == null || s.py == null) continue;
    if (pass.length > 0 && s.t - pass[pass.length - 1]!.t > CARGO_PASS_GAP_MS) end();
    pass.push(s);
  }
  end();
  return out;
}
