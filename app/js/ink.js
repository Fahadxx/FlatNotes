// FlatNotes ink geometry: smoothing, pressure-mapped variable-width outlines, hit testing.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Map raw pointer pressure (0..1) to a radius scale. */
export function pressureScale(p, gamma = 1.35, minScale = 0.32) {
  const t = Math.pow(clamp(p, 0, 1), gamma);
  return minScale + (1 - minScale) * t;
}

/**
 * Light smoothing: box-filter positions & pressure, endpoints pinned.
 * strength 0..1 blends between raw and filtered.
 */
export function smoothPoints(pts, strength = 0.65) {
  const n = pts.length;
  if (n < 3 || strength <= 0) return pts;
  const out = new Array(n);
  out[0] = pts[0];
  out[n - 1] = pts[n - 1];
  for (let i = 1; i < n - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const fx = (a.x + b.x * 2 + c.x) / 4;
    const fy = (a.y + b.y * 2 + c.y) / 4;
    const fp = (a.p + b.p * 2 + c.p) / 4;
    out[i] = {
      x: b.x + (fx - b.x) * strength,
      y: b.y + (fy - b.y) * strength,
      p: b.p + (fp - b.p) * strength,
    };
  }
  return out;
}

/** Drop points closer than minDist to their predecessor (keeps last). */
export function cullPoints(pts, minDist = 0.35) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  const md2 = minDist * minDist;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1], p = pts[i];
    const dx = p.x - prev.x, dy = p.y - prev.y;
    if (dx * dx + dy * dy >= md2) out.push(p);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Build a filled Path2D outline for a stroke.
 * points: [{x,y,p}] in page coords. size: base diameter.
 * opts: { pressure:boolean, gamma, minScale, taper:boolean }
 */
export function buildStrokePath(points, size, opts = {}) {
  const usePressure = opts.pressure !== false;
  const gamma = opts.gamma ?? 1.35;
  const minScale = opts.minScale ?? 0.32;
  const path = new Path2D();
  let pts = cullPoints(points);
  const n = pts.length;
  if (n === 0) return path;

  const radius = (p) =>
    Math.max(0.3, (size / 2) * (usePressure ? pressureScale(p, gamma, minScale) : 1));

  // total length - tiny strokes render as a dot
  let total = 0;
  for (let i = 1; i < n; i++) {
    total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  if (n === 1 || total < 0.8) {
    const p = pts[0];
    const r = radius(Math.max(p.p, 0.45));
    path.arc(p.x, p.y, r, 0, Math.PI * 2);
    return path;
  }

  pts = smoothPoints(pts, opts.smooth ?? 0.65);

  // per-point unit normals from central-difference directions
  const L = [], R = [];
  let pdx = 0, pdy = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(n - 1, i + 1)];
    let dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) { dx = pdx; dy = pdy; }
    else { dx /= len; dy /= len; pdx = dx; pdy = dy; }
    const r = radius(pts[i].p);
    const nx = -dy, ny = dx;
    L.push({ x: pts[i].x + nx * r, y: pts[i].y + ny * r });
    R.push({ x: pts[i].x - nx * r, y: pts[i].y - ny * r });
  }

  // left side down, rounded end cap, right side back, rounded start cap
  path.moveTo(L[0].x, L[0].y);
  for (let i = 1; i < n; i++) {
    const mx = (L[i - 1].x + L[i].x) / 2, my = (L[i - 1].y + L[i].y) / 2;
    path.quadraticCurveTo(L[i - 1].x, L[i - 1].y, mx, my);
  }
  path.lineTo(L[n - 1].x, L[n - 1].y);
  {
    const c = pts[n - 1], r = radius(c.p);
    const a0 = Math.atan2(L[n - 1].y - c.y, L[n - 1].x - c.x);
    path.arc(c.x, c.y, r, a0, a0 - Math.PI, true);
  }
  for (let i = n - 2; i >= 0; i--) {
    const mx = (R[i + 1].x + R[i].x) / 2, my = (R[i + 1].y + R[i].y) / 2;
    path.quadraticCurveTo(R[i + 1].x, R[i + 1].y, mx, my);
  }
  path.lineTo(R[0].x, R[0].y);
  {
    const c = pts[0], r = radius(c.p);
    const a0 = Math.atan2(R[0].y - c.y, R[0].x - c.x);
    path.arc(c.x, c.y, r, a0, a0 - Math.PI, true);
  }
  path.closePath();
  return path;
}

/** Axis-aligned bbox of points, padded by pad. Returns {x,y,w,h}. */
export function bboxOfPoints(points, pad = 0) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** Squared distance from point to segment. */
export function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = 0;
  if (l2 > 0) t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
  const cx = ax + dx * t - px, cy = ay + dy * t - py;
  return cx * cx + cy * cy;
}

/** Does a circle (x,y,r) hit the stroke's polyline (with stroke radius added)? */
export function strokeHitCircle(stroke, x, y, r) {
  const b = stroke.bbox;
  const pad = r + stroke.size;
  if (b && (x < b.x - pad || x > b.x + b.w + pad || y < b.y - pad || y > b.y + b.h + pad)) return false;
  const pts = stroke.points;
  const rr = r + stroke.size / 2;
  const rr2 = rr * rr;
  if (pts.length === 1) {
    const dx = pts[0].x - x, dy = pts[0].y - y;
    return dx * dx + dy * dy <= rr2;
  }
  for (let i = 1; i < pts.length; i++) {
    if (segDist2(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= rr2) return true;
  }
  return false;
}

/** Ray-cast point-in-polygon. poly: [{x,y}]. */
export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Fraction of stroke points inside polygon (for lasso selection). */
export function fractionInPolygon(points, poly) {
  if (!points.length) return 0;
  let hit = 0;
  const step = Math.max(1, Math.floor(points.length / 40));
  let tested = 0;
  for (let i = 0; i < points.length; i += step) {
    tested++;
    if (pointInPolygon(points[i].x, points[i].y, poly)) hit++;
  }
  return hit / tested;
}
