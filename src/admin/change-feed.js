/**
 * ChangeFeed — an in-process pub/sub bus for portal live updates (SSE).
 *
 * Every mutation appends a sequenced event. Subscribers receive a snapshot of
 * events after their last-seen sequence, then live events. A bounded ring buffer
 * means a reconnecting client that missed nothing gets an exact replay; a client
 * that fell too far behind is told to do an authoritative refresh (the portal
 * polls the REST snapshot on `resync`), rather than being silently wrong.
 *
 * This is intentionally process-local: the portal is mounted on the existing
 * single server, and durable history lives in the NDJSON stores, not here.
 */
export class ChangeFeed {
  constructor({ bufferSize = 500 } = {}) {
    this.bufferSize = bufferSize;
    this.seq = 0;
    this.buffer = [];
    this.subscribers = new Set();
  }

  #record(evt) {
    return { seq: ++this.seq, at: new Date().toISOString(), ...evt };
  }

  emit(type, data = {}) {
    const evt = this.#record({ type, data });
    this.buffer.push(evt);
    if (this.buffer.length > this.bufferSize) this.buffer.splice(0, this.buffer.length - this.bufferSize);
    for (const sub of this.subscribers) {
      try {
        sub(evt);
      } catch {
        /* a dead subscriber must not break a mutation */
      }
    }
    return evt;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Events after `sinceSeq`. `gap: true` means the client missed the window. */
  replay(sinceSeq = 0) {
    const oldest = this.buffer.length ? this.buffer[0].seq : this.seq + 1;
    if (sinceSeq + 1 < oldest && this.buffer.length) return { gap: true, events: [] };
    return { gap: false, events: this.buffer.filter((e) => e.seq > sinceSeq) };
  }

  currentSeq() {
    return this.seq;
  }
}

export const changeFeed = new ChangeFeed();
