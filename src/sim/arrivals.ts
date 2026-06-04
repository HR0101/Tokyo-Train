import type { LngLat, RailLine, StationPoint, TrainState } from './types';
import { distanceMeters, pathLength } from './geo';

// 駅がその路線に「停車する」とみなす最大距離（メートル）
const STOP_THRESHOLD_M = 250;
// 駅リストを持たない路線で、経路から停車駅とみなす最大距離（メートル）
const PATH_THRESHOLD_M = 300;

// クリックした駅に乗り入れる路線（乗り換え候補）
export interface ServingLine {
  lineId: string;
  displayName: string;
  color: [number, number, number];
  stationFraction: number; // 駅の path 上の位置（0〜1）
  lineLen: number; // 路線全長（メートル）
  isLoop: boolean;
  destFwd: string; // direction +1 の終点名
  destBack: string; // direction -1 の終点名
  nearest: number; // 駅からの最短距離（メートル）
}

// 到着予測 1 件
export interface Arrival {
  lineId: string;
  displayName: string;
  color: [number, number, number];
  dirLabel: string; // 「○○方面」「外回り」など
  etaSec: number;
}

// 路線名から方向・系統の補足やコードを除いて表示名にする
export function displayLineName(name: string): string {
  let n = name.split(/\s*[:：]\s*/)[0]; // コロン以降（方向・区間）を除去
  n = n.replace(/^列車\s*/, '').trim(); // 「列車 」接頭辞を除去
  n = n.replace(/\s*(快速急行|通勤快速|通勤急行|区間快速|区間急行|各駅停車|各停|快速|急行|準急|特急|普通)$/g, '').trim();
  n = n.replace(/(線)[A-Z]{1,4}$/, '$1'); // 末尾の路線コード（例: 中央線JC）を除去
  return n.trim();
}

// 乗り換えリストから除外する「列車名（特急・新幹線など）」「英語系統名」の判定
const ASCII_ONLY = /^[\x00-\x7F\s]+$/;
const SERVICE_NAME =
  /(新幹線|列車|快特|特快|エアポート|アクセス特急|ひたち|ときわ|あずさ|かいじ|富士回遊|踊り子|サフィール|はこね|さがみ|えのしま|ふじさん|モーニングウェイ|ホームウェイ|日光|きぬがわ|スペーシア|リバティ|しおさい|わかしお|さざなみ|あやめ|成田エクスプレス|草津|あかぎ|スワロー|のぞみ|ひかり|こだま|みずほ|さくら|つばめ|はやぶさ|はやて|やまびこ|なすの|つばさ|とき|たにがわ|かがやき|はくたか|あさま|つるぎ|こまち)/;

// 乗り換え路線として不適切（特急・新幹線の列車名、英語系統名、複数路線の連結系統名）か
export function isServiceRelation(name: string): boolean {
  if (ASCII_ONLY.test(name)) return true; // 英語系統名
  if (name.includes(' - ')) return true; // 複数路線を連結した直通系統名
  if (/新幹線/.test(name)) return true; // 新幹線は標準的な乗換経路から除外する
  // 「○○線」で終わる正式な路線名は、特急の列車名と同じ綴り（例:「東武日光線」と特急「日光」）でも
  // 通常路線として扱い、経路探索・乗換案内に含める
  if (/線$/.test(name)) return false;
  return SERVICE_NAME.test(name); // 特急などの列車名
}

// 駅の path 上の最近傍インデックスと距離を求める
function nearestOnPath(station: StationPoint, path: LngLat[]): { index: number; dist: number } {
  const sp: LngLat = [station.lng, station.lat];
  let best = Infinity;
  let bestIdx = 0;
  for (let i = 0; i < path.length; i++) {
    const d = distanceMeters(sp, path[i]);
    if (d < best) {
      best = d;
      bestIdx = i;
    }
  }
  return { index: bestIdx, dist: best };
}

// 駅リスト内で駅に最も近いエントリの距離
function nearestStationDist(station: StationPoint, stations: StationPoint[]): number {
  const sp: LngLat = [station.lng, station.lat];
  let best = Infinity;
  for (const s of stations) {
    const d = distanceMeters(sp, [s.lng, s.lat]);
    if (d < best) best = d;
  }
  return best;
}

// クリックした駅に停車する路線を求める（乗り換え路線リスト）
export function findServingLines(station: StationPoint, lines: RailLine[]): ServingLine[] {
  const byName = new Map<string, ServingLine & { points: number }>();
  for (const line of lines) {
    if (line.name.includes('直通') || line.path.length < 2) continue;
    if (isServiceRelation(line.name)) continue; // 特急・新幹線の列車名や英語系統名を除外

    // 駅の path 上の位置（到着予測に使う）
    const near = nearestOnPath(station, line.path);

    // この駅に停車するか判定
    let serves = false;
    let nearest = near.dist;
    if (line.stations && line.stations.length > 0) {
      const sd = nearestStationDist(station, line.stations);
      if (sd <= STOP_THRESHOLD_M) {
        serves = true;
        nearest = sd;
      }
    } else if (near.dist <= PATH_THRESHOLD_M) {
      serves = true;
    }
    if (!serves) continue;

    const n = line.path.length;
    const stationFraction = line.isLoop ? near.index / n : n > 1 ? near.index / (n - 1) : 0;
    const dn = displayLineName(line.name);
    const entry: ServingLine & { points: number } = {
      lineId: line.id,
      displayName: dn,
      color: line.color,
      stationFraction,
      lineLen: pathLength(line.path, line.isLoop),
      isLoop: line.isLoop,
      destFwd: line.stations?.[line.stations.length - 1]?.name ?? '',
      destBack: line.stations?.[0]?.name ?? '',
      nearest,
      points: line.path.length,
    };
    // 同名の系統は最も完全（点数が多い）なものを採用
    const prev = byName.get(dn);
    if (!prev || entry.points > prev.points) byName.set(dn, entry);
  }
  return [...byName.values()].sort((a, b) => a.nearest - b.nearest);
}

// 進行方向 dir で from から to までの前方距離（0〜1）。到達しないなら null。
function forwardGap(from: number, to: number, dir: 1 | -1, isLoop: boolean): number | null {
  const mod1 = (x: number) => ((x % 1) + 1) % 1;
  if (isLoop) {
    return dir === 1 ? mod1(to - from) : mod1(from - to);
  }
  if (dir === 1) return to >= from ? to - from : null;
  return from >= to ? from - to : null;
}

// 方向ラベル（環状＝外回り/内回り、それ以外＝終点名方面）
function directionLabel(s: ServingLine, dir: 1 | -1): string {
  if (s.isLoop) return dir === 1 ? '外回り' : '内回り';
  const dest = dir === 1 ? s.destFwd : s.destBack;
  if (dest) return `${dest}方面`;
  return dir === 1 ? '下り' : '上り';
}

// 現在の列車位置から、各路線・各方向の次の到着予測を求める
export function nextArrivals(serving: ServingLine[], trains: TrainState[]): Arrival[] {
  const result: Arrival[] = [];
  // 路線ID → その路線の列車
  const byLine = new Map<string, TrainState[]>();
  for (const t of trains) {
    if (!byLine.has(t.lineId)) byLine.set(t.lineId, []);
    byLine.get(t.lineId)!.push(t);
  }

  for (const s of serving) {
    const lineTrains = byLine.get(s.lineId) ?? [];
    for (const dir of [1, -1] as const) {
      let bestEta = Infinity;
      for (const t of lineTrains) {
        if (t.direction !== dir) continue;
        const gap = forwardGap(t.lineFraction, s.stationFraction, dir, s.isLoop);
        if (gap == null) continue;
        const speed = t.speedMps > 0 ? t.speedMps : 1;
        const eta = (gap * s.lineLen) / speed;
        if (eta < bestEta) bestEta = eta;
      }
      if (Number.isFinite(bestEta)) {
        result.push({
          lineId: s.lineId,
          displayName: s.displayName,
          color: s.color,
          dirLabel: directionLabel(s, dir),
          etaSec: bestEta,
        });
      }
    }
  }
  return result.sort((a, b) => a.etaSec - b.etaSec);
}
