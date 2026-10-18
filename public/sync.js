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

export const POLL_INTERVALS = [3000, 6000, 12000, 30000];
export const POLL_IDLE_MS = 600000;
export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(
    0,
    Number.isFinite(seconds)
      ? seconds * 1000
      : (Date.parse(value) || now) - now,
  );
}
export function visiblePolling(
  doc,
  poll,
  timers = {
    setTimeout: (...args) => globalThis.setTimeout(...args),
    clearTimeout: (...args) => globalThis.clearTimeout(...args),
  },
  options = {},
) {
  const now = options.now || Date.now;
  const eligible = options.eligible || (() => true);
  const onPause = options.onPause || (() => {});
  let resetNext = false;
  let timer,
    active = false,
    stopped = false,
    idle = false,
    step = 0;
  let lastActivity = now(),
    activityVersion = 0,
    notBefore = 0,
    due = now() + POLL_INTERVALS[0];
  const events = ["pointerdown", "keydown", "scroll", "input"];
  function pause(value) {
    if (idle !== value) {
      idle = value;
      onPause(value);
    }
  }
  function schedule() {
    timers.clearTimeout(timer);
    if (stopped || active || doc.hidden || !eligible()) return;
    if (now() - lastActivity >= POLL_IDLE_MS) {
      pause(true);
      return;
    }
    timer = timers.setTimeout(
      run,
      Math.max(
        0,
        Math.min(Math.max(due, notBefore), lastActivity + POLL_IDLE_MS) - now(),
      ),
    );
  }
  async function run() {
    timers.clearTimeout(timer);
    if (stopped || active || doc.hidden || !eligible()) return;
    if (now() - lastActivity >= POLL_IDLE_MS) {
      pause(true);
      return;
    }
    if (now() < notBefore) {
      schedule();
      return;
    }
    active = true;
    const version = activityVersion,
      reset = resetNext;
    resetNext = false;
    try {
      const result = await poll();
      if (result?.stop) {
        stop();
        return;
      }
      step =
        reset || result?.updated || version !== activityVersion
          ? 0
          : Math.min(step + 1, POLL_INTERVALS.length - 1);
    } catch (error) {
      if (error.status === 404) {
        stop();
        return;
      }
      step = Math.min(step + 1, POLL_INTERVALS.length - 1);
      notBefore = Math.max(notBefore, now() + (error.retryAfterMs || 0));
    } finally {
      active = false;
      due = now() + POLL_INTERVALS[step];
      schedule();
    }
  }
  function activity(immediate = false) {
    if (stopped) return;
    const resume = idle;
    if (immediate || resume) resetNext = true;
    lastActivity = now();
    activityVersion++;
    step = 0;
    pause(false);
    due =
      immediate || resume ? now() : Math.min(due, now() + POLL_INTERVALS[0]);
    if ((immediate || resume) && !active && now() >= notBefore) void run();
    else schedule();
  }
  const operated = () => activity();
  const changed = () => {
    timers.clearTimeout(timer);
    if (!doc.hidden) activity(true);
  };
  function stop() {
    stopped = true;
    timers.clearTimeout(timer);
    doc.removeEventListener("visibilitychange", changed);
    for (const event of events) doc.removeEventListener(event, operated, true);
  }
  stop.activity = activity;
  stop.refresh = () => activity(true);
  stop.reconcile = schedule;
  stop.defer = (error) => {
    step = Math.min(step + 1, POLL_INTERVALS.length - 1);
    notBefore = Math.max(notBefore, now() + (error.retryAfterMs || 0));
    due = now() + POLL_INTERVALS[step];
    schedule();
  };
  doc.addEventListener("visibilitychange", changed);
  for (const event of events) doc.addEventListener(event, operated, true);
  schedule();
  return stop;
}
export async function refreshAfterSuccess(load) {
  try {
    return { book: await load(), refreshError: null };
  } catch (refreshError) {
    return { book: null, refreshError };
  }
}
