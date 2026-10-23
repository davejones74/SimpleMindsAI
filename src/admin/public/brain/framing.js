const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const normalize = (value) => {
  const length = Math.hypot(value[0], value[1], value[2]) || 1;
  return [value[0] / length, value[1] / length, value[2] / length];
};

/**
 * Fit a perspective camera to an axis-aligned blueprint bounds box.
 *
 * Fitting the projected box (rather than a bounding sphere) avoids wasting most
 * of the viewport on a long, thin transformer stack. The same calculation is
 * used for the 8-layer prototype and the 36-layer target.
 */
export function fitCamera(bounds, options = {}) {
  const direction = normalize(options.direction ?? [1.6, 0.35, 0.8]);
  const fovDeg = options.fovDeg ?? 52;
  const aspect = Math.max(options.aspect ?? 1.96, 0.1);
  const margin = options.margin ?? 0.9;
  const min = bounds?.min ?? [-1, -1, -1];
  const max = bounds?.max ?? [1, 1, 1];
  const half = [
    Math.max(Math.abs(max[0] - min[0]) / 2, 0.01),
    Math.max(Math.abs(max[1] - min[1]) / 2, 0.01),
    Math.max(Math.abs(max[2] - min[2]) / 2, 0.01),
  ];
  const center = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const forward = direction.map((value) => -value);
  const right = normalize(cross(forward, [0, 1, 0]));
  const up = normalize(cross(right, forward));
  const projectedHalf = (axis) => (
    Math.abs(half[0] * axis[0]) + Math.abs(half[1] * axis[1]) + Math.abs(half[2] * axis[2])
  );
  const halfWidth = projectedHalf(right);
  const halfHeight = projectedHalf(up);
  const halfDepth = projectedHalf(forward);
  const tanHalfFov = Math.tan((fovDeg * Math.PI) / 360);
  const widthDistance = halfWidth / (tanHalfFov * aspect);
  const heightDistance = halfHeight / tanHalfFov;
  const distance = Math.max(widthDistance, heightDistance) * margin + halfDepth;
  const position = [
    center[0] + direction[0] * distance,
    center[1] + direction[1] * distance,
    center[2] + direction[2] * distance,
  ];
  const extent = Math.hypot(half[0], half[1], half[2]);
  return {
    center,
    position,
    direction,
    distance,
    near: Math.max(0.1, distance * 0.005),
    far: Math.max(distance + extent * 3, distance * 3),
    boundsHalf: half,
    projected: { halfWidth, halfHeight, halfDepth },
  };
}
