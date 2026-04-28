import { geoPath } from "d3-geo";
import { normalizeRenderOrder } from "../core/layer-config.js";

export function hexToRgb(hex, fallback = { r: 0, g: 0, b: 0 }) {
  const normalized = String(hex ?? "").trim().replace(/^#/, "");
  if (!/^[\da-f]{6}$/i.test(normalized)) return fallback;
  const value = Number.parseInt(normalized, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
}

export function toCssColor(hex, opacity = 100) {
  const { r, g, b } = hexToRgb(hex);
  const alpha = Math.max(0, Math.min(100, Number(opacity) || 0)) / 100;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function isChannelVisible(channel) {
  return channel?.visible !== false;
}

export function getLineWidth(line) {
  return Math.max(0, Number(line?.width) || 0);
}

export function drawFilledPath(ctx, path2d, fill) {
  if (!path2d || !isChannelVisible(fill)) return false;
  ctx.fillStyle = toCssColor(fill.color, fill.opacity);
  ctx.fill(path2d, "nonzero");
  return true;
}

export function drawStrokedPath(ctx, path2d, line) {
  const width = getLineWidth(line);
  if (!path2d || !isChannelVisible(line) || width <= 0) return false;
  ctx.strokeStyle = toCssColor(line.color, line.opacity);
  ctx.lineWidth = width;
  ctx.stroke(path2d);
  return true;
}

export function drawFilledGeometry(ctx, path, geometry, fill) {
  if (!geometry || !isChannelVisible(fill)) return;
  ctx.beginPath();
  path(geometry);
  ctx.fillStyle = toCssColor(fill.color, fill.opacity);
  ctx.fill("nonzero");
}

export function drawStrokedGeometry(ctx, path, geometry, line) {
  const width = getLineWidth(line);
  if (!geometry || !isChannelVisible(line) || width <= 0) return;
  ctx.beginPath();
  path(geometry);
  ctx.strokeStyle = toCssColor(line.color, line.opacity);
  ctx.lineWidth = width;
  ctx.stroke();
}

export function drawPointPositions(ctx, positions, point, pointLine) {
  if (!positions?.length || !isChannelVisible(point)) return;
  const radius = Math.max(1, Number(point?.radius) || 1);
  const strokeWidth = isChannelVisible(pointLine) ? Math.max(0, Number(pointLine?.width ?? 1) || 0) : 0;
  ctx.fillStyle = toCssColor(point.color, point.opacity);
  ctx.strokeStyle = toCssColor(pointLine?.color ?? "#000000", pointLine?.opacity ?? 100);
  ctx.lineWidth = strokeWidth;
  for (const [x, y] of positions) {
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
    if (strokeWidth > 0) ctx.stroke();
  }
}

export function prepareContext(ctx, width, height, backgroundFill) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = backgroundFill;
  ctx.fillRect(0, 0, width, height);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
}

export function drawProjectedScene(
  ctx,
  projectionAdapter,
  sceneProps,
  preparedDynamicCommands,
  {
    land,
    graticules,
    applyViewportTransform = true,
    includeEarth = true,
    includeDynamicShapes = true,
    includePoints = true,
    perfTracker = null,
  } = {},
) {
  const run = () => {
    const path = geoPath(projectionAdapter.projection, ctx);

    const spherePath = projectionAdapter.getStaticPath("sphere", { type: "Sphere" });
    const landPath = projectionAdapter.getStaticPath("land", land);
    const graticulesPath = projectionAdapter.getStaticPath("graticules", graticules);
    const earthRenderers = {
      "ocean.fill": () => {
        if (!drawFilledPath(ctx, spherePath, sceneProps.oceanFill)) {
          drawFilledGeometry(ctx, path, { type: "Sphere" }, sceneProps.oceanFill);
        }
      },
      "land.fill": () => {
        if (!drawFilledPath(ctx, landPath, sceneProps.landFill)) {
          drawFilledGeometry(ctx, path, land, sceneProps.landFill);
        }
      },
      "land.line": () => {
        if (!drawStrokedPath(ctx, landPath, sceneProps.landLine)) {
          drawStrokedGeometry(ctx, path, land, sceneProps.landLine);
        }
      },
      "graticules.line": () => {
        if (!drawStrokedPath(ctx, graticulesPath, sceneProps.graticulesLine)) {
          drawStrokedGeometry(ctx, path, graticules, sceneProps.graticulesLine);
        }
      },
    };

    ctx.save();
    if (spherePath) ctx.clip(spherePath);

    if (includeEarth) {
      [...normalizeRenderOrder(sceneProps.earthRenderOrder)].reverse().forEach((layerId) => {
        earthRenderers[layerId]?.();
      });
    }

    if (!includeDynamicShapes && !includePoints) {
      ctx.restore();
      return;
    }

    perfTracker?.gauge("dynamicCommandCount", preparedDynamicCommands.length);
    perfTracker?.time("dynamicReplayMs", () => {
      for (const command of preparedDynamicCommands) {
        if (command.kind === "fill" && includeDynamicShapes) {
          perfTracker?.increment("dynamicFillCommands");
          if (!drawFilledPath(ctx, projectionAdapter.getCommandPath(command), command.fill)) {
            drawFilledGeometry(ctx, path, command.geojson, command.fill);
          }
        } else if (command.kind === "line" && includeDynamicShapes) {
          perfTracker?.increment("dynamicLineCommands");
          if (!drawStrokedPath(ctx, projectionAdapter.getCommandPath(command), command.line)) {
            drawStrokedGeometry(ctx, path, command.geojson, command.line);
          }
        } else if (command.kind === "point" && includePoints) {
          perfTracker?.increment("dynamicPointCommands");
          drawPointPositions(
            ctx,
            projectionAdapter.getProjectedPoints(command),
            command.point,
            command.pointLine,
          );
        }
      }
    });

    ctx.restore();
  };

  if (applyViewportTransform) {
    projectionAdapter.applyViewportTransform(ctx, run);
    return;
  }
  run();
}
