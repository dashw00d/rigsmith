// The app's optimistic copy of a character (DESIGN.md §4.3). The server is the truth; the app shows the server's last
// copy with the command batches it has sent but not yet seen land laid on top, in the order they were issued, so an
// edit shows at once and a server copy arriving meanwhile (another tab, a job, a tool) never wipes it.
//
// Pure and generic over the document and command types so it can be tested without the model's reducers.

/** What the reconcile needs of a document: its write counter, and when it was made (a deleted character imported
 * again gets the same id but a new createdAt, and starts counting again). */
export interface Doc { version: number, createdAt: number }

/** Commands sent together as one journal entry, named by the client's id for them. */
export interface Batch<X> { cid: string, commands: X[] }

export interface Track<D extends Doc, X> {
  /** The newest copy the server has sent. */
  server: D
  /** Sent, not yet seen in a server copy (or answered), oldest first. */
  pending: Array<Batch<X>>
}

/** The reducer: a new document with the commands applied, or a throw when they don't apply. Must not change `doc`. */
export type Apply<D, X> = (doc: D, commands: X[]) => D

export function track<D extends Doc, X> (server: D): Track<D, X> {
  return { server, pending: [] }
}

export function push<D extends Doc, X> (t: Track<D, X>, batch: Batch<X>): Track<D, X> {
  return { server: t.server, pending: [...t.pending, batch] }
}

/** The batch is done with (its reply came, or it failed): it no longer shows. */
export function settle<D extends Doc, X> (t: Track<D, X>, cid: string): Track<D, X> {
  const pending = t.pending.filter(b => b.cid !== cid)
  return pending.length === t.pending.length ? t : { server: t.server, pending }
}

/**
 * A copy from the server (a command's reply, an SSE event, a refetch), with the cid of the entry that made it if any.
 * The copy is kept unless it is older than the one held; the batch it names is dropped either way (an older copy
 * that carries it means the newer one held already has it, since the server applies writes one after another).
 * Returns `t` itself when nothing changed, so callers can skip work.
 */
export function receive<D extends Doc, X> (t: Track<D, X> | undefined, copy: D, cid?: string): Track<D, X> {
  if (t === undefined) return track(copy)
  const settled = cid === undefined ? t : settle(t, cid)
  // (an equal version is the same write: keep the object held, so nothing re-renders for an echo)
  const newer = copy.version > t.server.version || copy.createdAt !== t.server.createdAt
  return newer ? { server: copy, pending: settled.pending } : settled
}

/** What the app shows: the server's copy with every pending batch on top, in order. A batch that no longer applies is
 * left out (the server will refuse it too, and its failure is reported then). */
export function shown<D extends Doc, X> (t: Track<D, X>, apply: Apply<D, X>): D {
  let doc = t.server
  for (const batch of t.pending) {
    try { doc = apply(doc, batch.commands) } catch { /* left out; see above */ }
  }
  return doc
}
