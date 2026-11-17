/**
 * Actions per minute, counted the way Brood War counts them. Raw only: every
 * press counts, repeats included. Nothing is dropped as "ineffective".
 *
 * Two figures, each taken from source that can be read rather than from a
 * description of it.
 *
 * The live one is APMAlert's — the counter players watch while they play.
 * BWAPI reimplements it and says so ("formula from APMAlert",
 * BWAPICore/APMCounter.cpp): every action is worth 1 when it happens and
 * decays as exp(-age / interval), and the sum is divided by the interval and
 * by `1 - exp(-gameTime / interval)` so the opening minutes do not read low.
 * The interval is StarCraft Remastered's, measured by hand: 43 seconds
 * rather than APMAlert's 0.95 minutes. See APM_INTERVAL_MIN.
 * See {@link liveApm}.
 *
 * The whole-match one is screp's, the parser behind most Brood War replay
 * sites. `rep/replay.go` counts every command a player sent and divides by
 * the game minutes up to that player's last command:
 *
 *     mins := pd.LastCmdFrame.Duration().Minutes()
 *     pd.APM  = int32(float64(pd.CmdCount)/mins + 0.5)
 *
 * Game minutes, not wall-clock ones: a Brood War frame is 42ms of game time
 * whatever speed the replay is watched at. Here the clock is the simulation
 * tick, which is the match's own time, so playing the replay faster runs more
 * ticks a second and cannot change the figure.
 *
 * Everything is derived from the command list alone. An earlier count pushed
 * an event every time a command was applied, and the simulation applies the
 * whole match once while it loads and again as it plays, and again from the
 * nearest snapshot on every seek — so every action counted at least twice and
 * a scrubbed replay counted some of them many times over.
 */
import { INPUT_EMPTY_BOX, type CmdKind, type ReplayCommand } from "./types";

/**
 * Commands that are something a player did.
 *
 * Everything else in the stream is the recording describing the game: `spawn`
 * is a unit being noticed, `credits` a balance being read, `kill`, `gone`,
 * `dock`, `capture`, `fx`, `fire`, `cargo` and `build` are things that
 * happened. Together `credits` and `spawn` were a third of what used to be
 * counted, and nobody pressed anything for either. (`build` is the sidebar's
 * record of a production item and is counted as the click that queued it;
 * see actionLog.)
 */
const ACTIONS: ReadonlySet<CmdKind> = new Set<CmdKind>([
  "deploy", "place", "queue", "move", "attack", "harvest", "stop", "sell",
  "select", "rally", "sel", "group", "repair", "target",
]);

/**
 * What a player input counts as, in the terms the screp rules use, or null
 * when it is not an action at all.
 *
 * Not actions: the right button going down (always paired with the click that
 * follows, which is counted), a change in Ctrl/Alt/Shift, and the client
 * reporting its selection after a click or box (code 0x9f), which the click
 * or box already counted.
 */
export function inputAction(code: number, event: number): CmdKind | null {
  switch (code) {
    case 0x1f:
      // Legacy controls send raw clicks; modern ones send select-at (9) and
      // command-at (10). Both are the player's clicks.
      if (event === 2 || event === 5 || event === 6 || event === 9) return "sel";
      if (event === 4 || event === 10) return "move";
      if (event === 7) return "sell";
      if (event === 8) return "repair";
      return null;
    case 0x6f:
      // Create (ctrl+N) is an assignment; the rest recall, which selects.
      return event === 1 ? "group" : "sel";
    case 0x4f:
      return event === 6 ? "place" : "queue";
    case 0x2f:
      // Structures: repairing (1, 2) and selling (3, 4), each sent as a press
      // on the sidebar button and one on the building. 5 cancels whichever
      // mode was open, and is a press of its own.
      return event === 1 || event === 2 ? "repair" : "sell";
    case 0x3f:
      // Units: scatter, select next, select previous, guard, stop. The two
      // that cycle the selection are selections; the rest are orders.
      return event === 2 || event === 3 ? "sel" : "stop";
    default:
      return null;
  }
}

/**
 * A selection change counts as its own press only when no stored input lands
 * this close around it, in ticks: from about 300ms before it to 50ms after.
 */
const SEL_EXPLAINED_BEFORE = 5;
const SEL_EXPLAINED_AFTER = 1;

/** Whether a command counts toward APM. */
export function isPlayerAction(c: Pick<ReplayCommand, "k" | "silent">): boolean {
  return !c.silent && ACTIONS.has(c.k);
}

/** A player's actions, in game ticks. */
export interface ActionLog {
  ticks: number[];
}

/**
 * Every action a player took, in order. Raw: every press counts, repeats
 * included.
 *
 * `commands` must be in tick order, as a replay's are.
 */
export function actionLog(
  commands: readonly ReplayCommand[],
  player: 0 | 1,
  _tickHz: number,
): ActionLog {
  // Production clicks come from the sidebar record, which has every item a
  // player queued — infantry and structures as well as vehicles — and every
  // one they cancelled. `queue` covers vehicles alone, so where the sidebar
  // is on record it stands in for `queue` rather than adding to it. A
  // queued item is one click; cancelling it is another, when it stopped.
  const hasSidebar = commands.some((c) => c.p === player && c.k === "build");
  const mine: ReplayCommand[] = [];
  // When the replay carries the player's own inputs, they are the actions:
  // every click, box, key and request, as sent. Nothing reconstructed is
  // needed alongside them, and counting both would count each action twice.
  if (commands.some((c) => c.p === player && c.k === "input")) {
    for (const c of commands) {
      if (c.p !== player || c.k !== "input" || c.target == null) continue;
      // A drag box that took nothing selected nothing: not an action.
      if (c.target & INPUT_EMPTY_BOX) continue;
      const k = inputAction((c.target >> 8) & 0xff, c.target & 0xff);
      if (k) mine.push({ ...c, k, silent: false });
    }
    // A selection change no stored input accounts for is a press all the
    // same: a control group recalled on the player's own screen, which the
    // client need not send. One match had 30 of 287 like that.
    const selecting = mine.filter((c) => c.k === "sel" || c.k === "move").map((c) => c.t);
    for (const c of commands) {
      if (c.p !== player || c.k !== "sel") continue;
      if (selecting.some((t) => t <= c.t + SEL_EXPLAINED_AFTER && t >= c.t - SEL_EXPLAINED_BEFORE)) continue;
      mine.push(c);
    }
    mine.sort((x, y) => x.t - y.t);
    return { ticks: mine.map((c) => Math.max(0, c.t)) };
  }
  for (const c of commands) {
    if (c.p !== player) continue;
    if (c.k === "build") {
      mine.push({ ...c, k: "queue", silent: false });
      if (c.id === 0 && c.target != null) mine.push({ ...c, t: c.t + c.target, k: "queue", silent: false });
      continue;
    }
    if (hasSidebar && c.k === "queue") continue;
    if (isPlayerAction(c)) mine.push(c);
  }
  mine.sort((x, y) => x.t - y.t);
  return { ticks: mine.map((c) => Math.max(0, c.t)) };
}

/**
 * How long the live figure remembers, in minutes: 45 seconds, measured in
 * StarCraft Remastered so the figure moves as StarCraft's does.
 *
 * APMAlert's formula has the right shape, but its 0.95 minutes forgets more
 * slowly than StarCraft Remastered's own figure. Measured against the game
 * itself: screenshots once a second of the figure StarCraft shows beside its
 * clock, 44 readings over two games, set against the commands in the same
 * games' replays. This formula on those commands gives every reading within a
 * point or two (1.5 APM off on average) at 45 seconds, rounded to the nearest
 * whole number; 43 seconds or truncating fits worse. Earlier hand tests with a
 * stopwatch (459 falling to 200 at 0:51-0:53 after spamming to 0:30; 400 held
 * to 3:02, half that at 3:32-3:33) agree within their few seconds. It drops
 * quickly early in a game because of the duration factor below, and more
 * gently later on.
 */
const APM_INTERVAL_MIN = 45 / 60;
const APM_INTERVAL_MS = APM_INTERVAL_MIN * 60_000;

/**
 * The live APM at `tick`, as APMAlert and BWAPI's `getAPM` compute it.
 *
 *     counter = counter * exp(-timeDifference / (APMInterval * 60000))   // each frame
 *     counter += 1                                                         // each action
 *     gameDurationFactor = 1 - exp(-totalTime / (APMInterval * 60000))
 *     apm = counter / (APMInterval * gameDurationFactor)
 *
 * Decaying the running counter frame by frame and adding one per action is the
 * same sum as adding up exp(-age / interval) over every action so far, which
 * is what this does, so the figure at a tick depends on nothing but the tick.
 * Times are game milliseconds; Brood War's are frames of 42ms. Rounded to the
 * nearest, as StarCraft Remastered's readings fit (APMAlert truncates).
 */
export function liveApm(log: ActionLog, tick: number, tickHz: number): number {
  const now = (tick * 1000) / tickHz;
  let counter = 0;
  for (const t of log.ticks) {
    if (t > tick) break;
    counter += Math.exp(-(now - (t * 1000) / tickHz) / APM_INTERVAL_MS);
  }
  const factor = Math.max(1e-100, 1 - Math.exp(-now / APM_INTERVAL_MS));
  return Math.round(counter / (APM_INTERVAL_MIN * factor));
}

/**
 * APM as screp would report it for the match cut off at `tick`.
 *
 * The divisor is the game time up to the player's latest action so far, the
 * same as screp's `LastCmdFrame`, so the figure at the end of a match is the
 * figure screp gives for the whole of it. An action at tick 0 cannot be
 * divided by, and screp skips a player whose last command is at frame 0.
 */
export function apmAt(log: ActionLog, tick: number, tickHz: number): { apm: number } {
  let n = 0;
  let last = 0;
  // Actions are in tick order; stop at the playhead.
  for (let i = 0; i < log.ticks.length; i++) {
    const t = log.ticks[i]!;
    if (t > tick) break;
    n++;
    last = t;
  }
  if (last <= 0) return { apm: 0 };
  const minutes = last / tickHz / 60;
  return { apm: Math.floor(n / minutes + 0.5) };
}
