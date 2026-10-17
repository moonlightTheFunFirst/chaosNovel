export function mergeDelta(base, delta) {
  if (
    delta.after !== base.revision ||
    delta.revision < base.revision ||
    delta.posts.length !== delta.revision - base.revision
  )
    throw new Error("revision mismatch");
  let total = base.posts.reduce((sum, p) => sum + p.count, 0);
  delta.posts.forEach((p, i) => {
    if (p.sequence !== base.revision + i + 1) throw new Error("sequence gap");
    total += p.count;
  });
  if (total !== delta.count) throw new Error("count mismatch");
  return {
    ...base,
    ...delta,
    own: Object.hasOwn(delta, "own") ? delta.own : base.own,
    posts: [...base.posts, ...delta.posts],
  };
}
export function visiblePolling(
  doc,
  poll,
  timers = { setTimeout, clearTimeout },
) {
  let timer,
    active = false,
    stopped = false;
  async function run() {
    timers.clearTimeout(timer);
    if (stopped || doc.hidden || active) return;
    active = true;
    try {
      await poll();
    } finally {
      active = false;
      if (!stopped && !doc.hidden) timer = timers.setTimeout(run, 3000);
    }
  }
  const changed = () => {
    timers.clearTimeout(timer);
    if (!doc.hidden) run();
  };
  doc.addEventListener("visibilitychange", changed);
  if (!doc.hidden) timer = timers.setTimeout(run, 3000);
  return () => {
    stopped = true;
    timers.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", changed);
  };
}
export async function refreshAfterSuccess(load) {
  try {
    return { book: await load(), refreshError: null };
  } catch (refreshError) {
    return { book: null, refreshError };
  }
}
