/** Cooperative-cancellation helpers shared by managed jobs. */

export function abortError(message = "job cancelled") {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function isAbort(err) {
  return err?.name === "AbortError" || err?.code === "ABORT_ERR";
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}
