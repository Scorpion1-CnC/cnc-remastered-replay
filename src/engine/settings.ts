/**
 * Match rule settings, modelled on the Command & Conquer Remastered
 * Quickmatch ladder configuration.
 *
 * The ladder runs a fixed ruleset rather than lobby defaults, so these are
 * the values a ranked replay should be reconstructed under.
 */

/** Remastered game-speed steps, slowest to fastest. */
export type GameSpeed = "slowest" | "slower" | "slow" | "normal" | "fast" | "faster" | "fastest";

export interface MatchSettings {
  gameSpeed: GameSpeed;
  /**
   * Tiberium regrowth rate as exposed by the Remastered options (higher =
   * faster regrowth). The ladder runs this at 3.
   */
  tiberiumRegrow: number;
  /** Whether Tiberium regrows/spreads at all. */
  tiberiumEnabled: boolean;
}

/**
 * The Quickmatch ladder ruleset.
 *
 * These are no longer assumed: the settings frame inside a real `.Replay`
 * carries the game's own rule JSON, and independent ranked matches record
 * `{"game_speed":5, "ore_regrows":3, "tech_level":6, …}` identically. Speed
 * index 5 is "fast" on the Remastered scale below, and `ore_regrows` is the
 * Tiberium regrowth rate. This constant is the fallback used when a match
 * has no downloadable replay; when one exists the recorded values win.
 */
export const QM_LADDER_SETTINGS: MatchSettings = {
  gameSpeed: "fast",
  tiberiumRegrow: 3,
  tiberiumEnabled: true,
};

/**
 * Remastered game-speed index -> speed step.
 *
 * Anchored on known ground truth: ranked Quickmatch runs at **"fast"**, and
 * every ranked replay inspected records `game_speed: 5`, so index 5 is
 * "fast" and the scale is offset by one from a plain 0-based
 * slowest..fastest list (index 0 is the unused slowest slot).
 */
const SPEED_BY_INDEX: GameSpeed[] = [
  "slowest",
  "slowest",
  "slower",
  "slow",
  "normal",
  "fast",
  "faster",
  "fastest",
];

/** Convert a replay's recorded rule JSON into the simulation's settings. */
export function settingsFromReplay(recorded: {
  game_speed?: number;
  ore_regrows?: number;
} | null | undefined): MatchSettings {
  if (!recorded) return QM_LADDER_SETTINGS;
  const speed =
    typeof recorded.game_speed === "number" ? SPEED_BY_INDEX[recorded.game_speed] : undefined;
  const regrow = typeof recorded.ore_regrows === "number" ? recorded.ore_regrows : undefined;
  return {
    gameSpeed: speed ?? QM_LADDER_SETTINGS.gameSpeed,
    tiberiumRegrow: regrow ?? QM_LADDER_SETTINGS.tiberiumRegrow,
    tiberiumEnabled: (regrow ?? QM_LADDER_SETTINGS.tiberiumRegrow) > 0,
  };
}

/**
 * Simulation ticks per second for each game-speed step.
 *
 * The original engine implements game speed as a frame delay rather than a
 * tick-rate table, so these are the effective logic rates that delay
 * produces, not values read out of the game data. The simulation and all
 * tick-derived timings (build order timestamps, APM buckets) are driven off
 * whichever rate is selected, so a replay reconstructed at ladder speed
 * lines up with the match duration the ladder reports.
 */
export const SPEED_TICK_HZ: Record<GameSpeed, number> = {
  slowest: 6,
  slower: 8,
  slow: 10,
  normal: 12,
  fast: 15,
  faster: 18,
  fastest: 20,
};

export function tickHzFor(settings: MatchSettings): number {
  return SPEED_TICK_HZ[settings.gameSpeed] ?? SPEED_TICK_HZ.fast;
}

/**
 * Real Quickmatch build times in seconds, at ladder speed ("fast").
 *
 * Measured from in-game footage by a top-ranked ladder player, timed as the
 * production-queue duration from start to finish (placement time excluded).
 * These are the values the ladder actually plays at, not derived from cost:
 * an Airstrip takes roughly nine times as long as a Power Plant, which no
 * cost-proportional estimate reproduces.
 *
 * Structures without a measured time fall back to a cost-scaled estimate
 * anchored on the Refinery, which is flagged here rather than presented as
 * measured.
 */
export const BUILD_SECONDS: Partial<Record<string, number>> = {
  powr: 4.73, // Power Plant
  hand: 4.73, // Hand of Nod
  pyle: 4.73, // Barracks (GDI equivalent of Hand of Nod)
  proc: 11.87, // Refinery
  afld: 42.77, // Airstrip
  weap: 42.77, // Weapons Factory (GDI equivalent of Airstrip)
};

/** Anchor used to estimate build time for structures with no measured value. */
export const BUILD_SECONDS_PER_CREDIT = 11.87 / 2000;

