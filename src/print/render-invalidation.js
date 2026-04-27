const DEFAULT_PASSES = ["earth", "dynamic-shapes", "points", "frame"];

export function createRenderInvalidation(passes = DEFAULT_PASSES) {
  const dirty = new Set(passes);

  function invalidate(nextPasses = ["frame"]) {
    const list = Array.isArray(nextPasses) ? nextPasses : [nextPasses];
    if (list.includes("all")) {
      passes.forEach((pass) => dirty.add(pass));
      return;
    }
    list.forEach((pass) => {
      if (passes.includes(pass)) {
        dirty.add(pass);
      }
    });
  }

  function consume() {
    const snapshot = new Set(dirty);
    dirty.clear();
    return snapshot;
  }

  function has(pass) {
    return dirty.has(pass);
  }

  function hasAny() {
    return dirty.size > 0;
  }

  return {
    consume,
    has,
    hasAny,
    invalidate,
  };
}
