/**
 * Inflating a replay's frames, in node or in a browser.
 *
 * Every compressed chunk in a `.Replay` was written with a sync flush: the
 * recorder emits each frame as it happens and never closes the stream, so the
 * deflate data has no final block. `node:zlib` has a switch for exactly this
 * (`finishFlush: Z_SYNC_FLUSH`, "give me what you have and do not complain
 * that it does not end"), which is why the decoder was server-only.
 *
 * The browser's `DecompressionStream` has no such switch — but it does not
 * need one. It emits decompressed bytes as it goes and only raises the
 * "unexpected end" at the very end, after everything it could decode has
 * already been handed over. So read the chunks, and when the stream finally
 * objects, keep what arrived. That is the same bytes zlib's sync flush
 * returns, with nothing to install.
 *
 * `node:zlib` is still preferred where it exists: it is synchronous and does
 * the whole file in one pass, and a replay is tens of thousands of frames.
 */

type NodeZlib = typeof import("node:zlib");

let nodeZlib: NodeZlib | null | undefined;

/**
 * The node implementation, or null in a browser.
 *
 * Resolved once and remembered — this is called per frame, and a replay has
 * thousands of them.
 */
async function zlibIfNode(): Promise<NodeZlib | null> {
  if (nodeZlib !== undefined) return nodeZlib;
  // `process.versions.node` rather than a try/catch around the import: a
  // bundler that has stubbed `node:zlib` hands back a module whose functions
  // throw at call time, which would be one failure per frame.
  // A way to exercise the browser path from node, so the two can be checked
  // against each other on real files (scripts/replay-research/_inflateparity.ts).
  if (typeof process !== "undefined" && process.env?.TD_FORCE_STREAM_INFLATE) {
    nodeZlib = null;
    return null;
  }
  const isNode =
    typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null &&
    // Vite sets this in the browser build, where a node built-in would only
    // resolve to a stub.
    typeof window === "undefined";
  if (!isNode) {
    nodeZlib = null;
    return null;
  }
  try {
    nodeZlib = await import("node:zlib");
  } catch {
    nodeZlib = null;
  }
  return nodeZlib;
}

/** Whether inflating will be synchronous — true on the server. */
export async function inflateIsSync(): Promise<boolean> {
  return (await zlibIfNode()) != null;
}

/**
 * Inflate one zlib payload that may stop mid-stream, or null if it will not
 * decode at all.
 */
export async function inflateSyncFlush(payload: Uint8Array): Promise<Uint8Array | null> {
  const zlib = await zlibIfNode();
  if (zlib) {
    try {
      return new Uint8Array(zlib.inflateSync(payload, { finishFlush: zlib.constants.Z_SYNC_FLUSH }));
    } catch {
      return null;
    }
  }
  return inflateViaStream(payload);
}

async function inflateViaStream(payload: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === "undefined") return null;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    const stream = new Blob([payload as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    // The "unexpected end of input" a sync-flushed stream always ends with.
    // Everything decodable arrived before it was raised, so fall through and
    // return that rather than throwing the frame away.
  }
  if (total === 0) return null;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
