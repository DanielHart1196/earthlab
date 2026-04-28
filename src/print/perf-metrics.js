const PERF_STORAGE_KEY = "earthlab.printPerf";

function now() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function shouldEnablePrintPerf() {
  if (globalThis.__EARTHLAB_PRINT_PERF__ === false) {
    return false;
  }
  if (globalThis.__EARTHLAB_PRINT_PERF__ === true) {
    return true;
  }
  try {
    if (globalThis.localStorage?.getItem(PERF_STORAGE_KEY) === "0") {
      return false;
    }
    if (globalThis.localStorage?.getItem(PERF_STORAGE_KEY) === "1") {
      return true;
    }
  } catch {
    // Ignore storage failures.
  }
  return true;
}

export function createPerfTracker(namespace, enabled = false) {
  const durations = new Map();
  const counters = new Map();
  const gauges = new Map();

  function durationEntry(name) {
    let entry = durations.get(name);
    if (!entry) {
      entry = { total: 0, count: 0, max: 0 };
      durations.set(name, entry);
    }
    return entry;
  }

  function recordDuration(name, duration) {
    if (!enabled) {
      return duration;
    }
    const entry = durationEntry(name);
    entry.total += duration;
    entry.count += 1;
    entry.max = Math.max(entry.max, duration);
    return duration;
  }

  function time(name, fn) {
    if (!enabled) {
      return fn();
    }
    const started = now();
    try {
      return fn();
    } finally {
      recordDuration(name, now() - started);
    }
  }

  function increment(name, delta = 1) {
    if (!enabled) {
      return;
    }
    counters.set(name, (counters.get(name) ?? 0) + delta);
  }

  function gauge(name, value) {
    if (!enabled) {
      return;
    }
    gauges.set(name, value);
  }

  function snapshot({ reset = false } = {}) {
    if (!enabled) {
      return null;
    }
    const nextDurations = {};
    durations.forEach((entry, name) => {
      nextDurations[name] = {
        total: Number(entry.total.toFixed(3)),
        count: entry.count,
        avg: entry.count ? Number((entry.total / entry.count).toFixed(3)) : 0,
        max: Number(entry.max.toFixed(3)),
      };
    });
    const result = {
      namespace,
      durations: nextDurations,
      counters: Object.fromEntries(counters),
      gauges: Object.fromEntries(gauges),
      capturedAt: Date.now(),
    };
    if (reset) {
      durations.clear();
      counters.clear();
      gauges.clear();
    }
    return result;
  }

  function publish({ reset = false } = {}) {
    if (!enabled) {
      return null;
    }
    const result = snapshot({ reset });
    globalThis.__earthlabPrintPerfLatest = {
      ...(globalThis.__earthlabPrintPerfLatest ?? {}),
      [namespace]: result,
    };
    return result;
  }

  return {
    enabled,
    gauge,
    increment,
    publish,
    recordDuration,
    snapshot,
    time,
  };
}
