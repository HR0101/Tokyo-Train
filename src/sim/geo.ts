import type { LngLat } from './types';

// 地球の半径（メートル）
const EARTH_RADIUS_M = 6378137;
// 度→ラジアン変換係数
const DEG_TO_RAD = Math.PI / 180;

// 2 点間の距離（メートル）を平面近似で求める。
// 都市スケールでは Haversine とほぼ同精度で、計算が軽い。
export function distanceMeters(a: LngLat, b: LngLat): number {
  const meanLatRad = ((a[1] + b[1]) / 2) * DEG_TO_RAD;
  const dx = (b[0] - a[0]) * DEG_TO_RAD * Math.cos(meanLatRad) * EARTH_RADIUS_M;
  const dy = (b[1] - a[1]) * DEG_TO_RAD * EARTH_RADIUS_M;
  return Math.hypot(dx, dy);
}

// 2 点を t（0〜1）で線形補間する
export function lerpCoord(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// 2 点を結ぶ進行方位（度、北から時計回り 0〜360）を求める
export function bearingDeg(a: LngLat, b: LngLat): number {
  const meanLatRad = ((a[1] + b[1]) / 2) * DEG_TO_RAD;
  const east = (b[0] - a[0]) * Math.cos(meanLatRad);
  const north = b[1] - a[1];
  const deg = Math.atan2(east, north) * (180 / Math.PI);
  return (deg + 360) % 360;
}

// ポリラインの全長（メートル）を求める。isLoop なら終点と始点も結ぶ。
export function pathLength(path: LngLat[], isLoop: boolean): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    total += distanceMeters(path[i], path[i + 1]);
  }
  if (isLoop && path.length > 1) {
    total += distanceMeters(path[path.length - 1], path[0]);
  }
  return total;
}
