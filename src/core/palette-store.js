const DEFAULT_PRESET_COLORS = [
  "#000000",
  "#FFFFFF",
  "#d94b4b",
  "#e58a2b",
  "#e5c84a",
  "#5b8c5a",
  "#4b6ed9",
  "#8c5bd6",
];

function normalizeHexColor(value) {
  const normalized = String(value ?? "").trim().replace(/^#/, "").toLowerCase();
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return null;
  }
  return `#${normalized}`;
}

function createPaletteStore({
  storageKey = "earthlab.palette.v1",
  presetColors = DEFAULT_PRESET_COLORS,
} = {}) {
  function read() {
    try {
      const raw = window.localStorage?.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed
        .map((value) => normalizeHexColor(value))
        .filter(Boolean)
        .filter((color, index, items) => items.indexOf(color) === index);
    } catch {
      return [];
    }
  }

  function write(colors) {
    try {
      window.localStorage?.setItem(storageKey, JSON.stringify(colors));
    } catch {
      // Ignore storage failures and keep runtime usable.
    }
  }

  function getState() {
    return {
      presets: presetColors.map((value) => normalizeHexColor(value)).filter(Boolean),
      custom: read(),
    };
  }

  function add(color) {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return getState();
    }
    const next = read();
    if (!next.includes(normalized)) {
      next.push(normalized);
      write(next);
    }
    return getState();
  }

  function remove(color) {
    const normalized = normalizeHexColor(color);
    if (!normalized) {
      return getState();
    }
    write(read().filter((entry) => entry !== normalized));
    return getState();
  }

  return {
    add,
    getState,
    normalizeHexColor,
    remove,
  };
}

export {
  DEFAULT_PRESET_COLORS,
  createPaletteStore,
  normalizeHexColor,
};
