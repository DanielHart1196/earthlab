import { normalizeHexColor } from "../core/palette-store.js";

function hexToRgb(hex, fallback = { r: 255, g: 255, b: 255 }) {
  const normalized = String(hex ?? "").trim().replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return fallback;
  }
  const value = Number.parseInt(normalized, 16);
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  };
}

function rgbToHex({ r, g, b }) {
  const toPart = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${toPart(r)}${toPart(g)}${toPart(b)}`;
}

function rgbToHsv({ r, g, b }) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = ((blue - red) / delta) + 2;
    } else {
      hue = ((red - green) / delta) + 4;
    }
  }

  return {
    h: ((hue * 60) + 360) % 360,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

function hsvToRgb({ h, s, v }) {
  const hue = ((h % 360) + 360) % 360;
  const chroma = v * s;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = v - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;

  if (hue < 60) {
    red = chroma;
    green = x;
  } else if (hue < 120) {
    red = x;
    green = chroma;
  } else if (hue < 180) {
    green = chroma;
    blue = x;
  } else if (hue < 240) {
    green = x;
    blue = chroma;
  } else if (hue < 300) {
    red = x;
    blue = chroma;
  } else {
    red = chroma;
    blue = x;
  }

  return {
    r: (red + match) * 255,
    g: (green + match) * 255,
    b: (blue + match) * 255,
  };
}

function hsvToHex(hsv) {
  return rgbToHex(hsvToRgb(hsv));
}

function bindPointerRegion(target, onMove) {
  function update(event) {
    const rect = target.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    onMove({ x, y, width: rect.width, height: rect.height });
  }

  target.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    target.setPointerCapture?.(event.pointerId);
    update(event);
  });

  target.addEventListener("pointermove", (event) => {
    if ((event.buttons & 1) !== 1 && event.pointerType !== "touch") {
      return;
    }
    update(event);
  });
}

function createSwatchButton(color, { removable = false } = {}) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "earthlab-color-swatch";
  button.style.setProperty("--swatch-color", color);
  button.setAttribute("aria-label", removable ? `Use or remove saved color ${color}` : `Use color ${color}`);
  button.title = removable ? `${color} • click to use • right-click to remove` : color;
  return button;
}

function mountColorControl({
  mount,
  initialValue,
  paletteStore,
  onChange,
}) {
  const wrapper = document.createElement("div");
  wrapper.className = "earthlab-color-control";

  const swatches = document.createElement("div");
  swatches.className = "earthlab-color-swatches";

  const panel = document.createElement("div");
  panel.className = "earthlab-color-panel";
  panel.hidden = true;

  const field = document.createElement("div");
  field.className = "earthlab-color-field";
  const fieldHandle = document.createElement("span");
  fieldHandle.className = "earthlab-color-field-handle";
  field.append(fieldHandle);

  const hue = document.createElement("div");
  hue.className = "earthlab-color-hue";
  const hueHandle = document.createElement("span");
  hueHandle.className = "earthlab-color-hue-handle";
  hue.append(hueHandle);

  const inputRow = document.createElement("div");
  inputRow.className = "earthlab-color-input-row";
  const hexInput = document.createElement("input");
  hexInput.className = "earthlab-color-hex";
  hexInput.type = "text";
  hexInput.spellcheck = false;
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "earthlab-color-save";
  saveButton.textContent = "Add";
  inputRow.append(hexInput, saveButton);

  panel.append(field, hue, inputRow);
  wrapper.append(swatches, panel);
  mount.append(wrapper);

  let currentHex = normalizeHexColor(initialValue) ?? "#8c6a2a";
  let currentHsv = rgbToHsv(hexToRgb(currentHex));

  function isOpen() {
    return panel.classList.contains("is-open");
  }

  function setOpen(nextOpen) {
    panel.classList.toggle("is-open", nextOpen);
    panel.hidden = !nextOpen;
    render();
  }

  function commitColor(nextHex, { persist = false, preserveHsv = false } = {}) {
    const normalized = normalizeHexColor(nextHex);
    if (!normalized) {
      hexInput.value = currentHex;
      return;
    }

    currentHex = normalized;
    if (!preserveHsv) {
      currentHsv = rgbToHsv(hexToRgb(currentHex));
    }

    onChange(currentHex);

    if (persist) {
      paletteStore.add(currentHex);
    }

    render();
  }

  function render() {
    const palette = paletteStore.getState();

    hexInput.value = currentHex;
    field.style.setProperty("--picker-hue", String(currentHsv.h));
    fieldHandle.style.left = `${currentHsv.s * 100}%`;
    fieldHandle.style.top = `${(1 - currentHsv.v) * 100}%`;
    hueHandle.style.left = `${(currentHsv.h / 360) * 100}%`;

    swatches.replaceChildren();

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "earthlab-color-swatch earthlab-color-swatch-add";
    addButton.classList.toggle("is-open", isOpen());
    addButton.textContent = "+";
    addButton.setAttribute("aria-label", isOpen() ? "Close color picker" : "Open color picker");
    addButton.addEventListener("click", () => {
      setOpen(!isOpen());
    });
    swatches.append(addButton);

    [...palette.custom, ...palette.presets.filter((color) => !palette.custom.includes(color))].forEach((color) => {
      const isCustom = palette.custom.includes(color);
      const button = createSwatchButton(color, { removable: isCustom });
      if (normalizeHexColor(currentHex) === color) {
        button.classList.add("is-active");
      }
      button.addEventListener("click", () => {
        commitColor(color);
      });
      if (isCustom) {
        button.addEventListener("contextmenu", (event) => {
          event.preventDefault();
          paletteStore.remove(color);
          render();
        });
      }
      swatches.append(button);
    });
  }

  bindPointerRegion(field, ({ x, y, width, height }) => {
    currentHsv = {
      ...currentHsv,
      s: width === 0 ? currentHsv.s : x / width,
      v: height === 0 ? currentHsv.v : 1 - (y / height),
    };
    commitColor(hsvToHex(currentHsv), { preserveHsv: true });
  });

  bindPointerRegion(hue, ({ x, width }) => {
    currentHsv = {
      ...currentHsv,
      h: Math.min(width === 0 ? currentHsv.h : (x / width) * 360, 359.999),
    };
    commitColor(hsvToHex(currentHsv), { preserveHsv: true });
  });

  hexInput.addEventListener("change", () => {
    commitColor(hexInput.value);
  });

  saveButton.addEventListener("click", () => {
    commitColor(hexInput.value, { persist: true });
    setOpen(false);
  });

  render();

  return {
    close() {
      setOpen(false);
    },
    contains(node) {
      return wrapper.contains(node);
    },
    render,
    setValue(nextValue) {
      const normalized = normalizeHexColor(nextValue);
      if (!normalized || normalized === currentHex) {
        return;
      }
      currentHex = normalized;
      currentHsv = rgbToHsv(hexToRgb(currentHex));
      render();
    },
  };
}

export {
  mountColorControl,
};
