import type { Theater } from "./types";

/**
 * Loader for the real Tiberian Dawn asset bundle shipped under
 * `public/assets/td/`. These are genuine, unmodified binary files pulled
 * from a real C&C95 install (palettes, terrain tile templates, unit and
 * structure sprites) — see ASSETS.md at the bundle root for provenance and
 * exactly which files are included.
 *
 * Everything here is a thin fetch+cache layer; the actual binary parsing
 * lives in palette.ts / tmp.ts / shp.ts.
 */

const TILE_EXT: Record<Theater, string> = {
  desert: "des",
  temperat: "tem",
  winter: "win",
};

const TILE_DIR: Record<Theater, string> = {
  desert: "desert",
  temperat: "temperate",
  winter: "winter",
};

const bufferCache = new Map<string, Promise<Uint8Array>>();

/** Tries per asset, and the wait before each retry (a phone's connection drops out). */
const FETCH_TRIES = 3;
const FETCH_RETRY_MS = 600;

/**
 * One asset's bytes, fetched once per visit. A failure is tried again a
 * couple of times and then not remembered: a dropped request on a phone used
 * to be cached as the answer, and every map after it drew without that art
 * -- Tiberium fields bare, for one.
 */
async function fetchBytes(url: string): Promise<Uint8Array> {
  const cached = bufferCache.get(url);
  if (cached) return cached;
  const p = (async () => {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url);
        // A missing file stays missing: only a failed request is retried.
        if (res.status === 404) throw Object.assign(new Error(`No asset ${url}`), { final: true });
        if (!res.ok) throw new Error(`Failed to load asset ${url}: ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      } catch (e) {
        if ((e as { final?: boolean }).final || attempt >= FETCH_TRIES) throw e;
        await new Promise((r) => setTimeout(r, FETCH_RETRY_MS * attempt));
      }
    }
  })();
  bufferCache.set(url, p);
  p.catch(() => {
    if (bufferCache.get(url) === p) bufferCache.delete(url);
  });
  return p;
}

export function palettePath(theater: Theater): string {
  const file = theater === "desert" ? "DESERT.PAL" : theater === "winter" ? "WINTER.PAL" : "TEMPERAT.PAL";
  return `/assets/td/palettes/${file}`;
}

export function fetchPaletteBytes(theater: Theater): Promise<Uint8Array> {
  return fetchBytes(palettePath(theater));
}

export function tmpPath(theater: Theater, templateName: string): string {
  return `/assets/td/tiles/${TILE_DIR[theater]}/${templateName.toLowerCase()}.${TILE_EXT[theater]}`;
}

export function fetchTmpBytes(theater: Theater, templateName: string): Promise<Uint8Array> {
  return fetchBytes(tmpPath(theater, templateName));
}

export function shpPath(fileName: string): string {
  return `/assets/td/sprites/general/${fileName.toLowerCase()}.shp`;
}

export function fetchShpBytes(fileName: string): Promise<Uint8Array> {
  return fetchBytes(shpPath(fileName));
}

/** Fetch a batch of named assets, tolerating individual 404s (returns null for those). */
export async function fetchManyOptional(urls: string[]): Promise<(Uint8Array | null)[]> {
  return Promise.all(
    urls.map((u) =>
      fetchBytes(u).catch(() => null as Uint8Array | null),
    ),
  );
}
