import type { OdptTrain, Rgb } from '../odpt/types';
import { fetchRailway, fetchStations, fetchTrains, LIVE_RAILWAYS } from '../odpt/client';
import { pathLength } from './geo';
import { TrainSim } from './TrainSim';
import type { LngLat, RailLine, StationPoint } from './types';

// 列車配置の共通設定
const TRAIN_SPACING_M = 5000; // この間隔ごとに 1 編成を配置する目安
const TRAIN_MIN_PER_DIR = 1; // 1 方向あたりの最小編成数
const TRAIN_MAX_PER_DIR = 6; // 1 方向あたりの最大編成数
const STATIC_TRAIN_SPEED_MPS = 34; // 静的モードの地上速度（約 122km/h）
const REAL_NOMINAL_SPEED_MPS = 14; // 実データモードの基準速度（ポーリングごとに補正）
// この全長未満かつ端点が近接する路線のみ環状とみなす（長距離路線の誤環状判定を防ぐ）
// ※ OSM の路線形状は実距離の約2倍（複線分など）になることがあるため余裕をもたせる
const LOOP_MAX_LENGTH_M = 90000;

// ネットワーク（路線＋全駅）
export interface Network {
  lines: RailLine[];
  stations: StationPoint[];
}

// ダッシュボードに表示する主要路線の定義（label: 表示名 / key: 路線名の一致キーワード）
const MAJOR_LINE_KEYS: { label: string; key: string }[] = [
  { label: '山手線', key: '山手' },
  { label: '中央線快速', key: '中央線快速' },
  { label: '京浜東北線', key: '京浜東北' },
  { label: '総武線', key: '総武' },
  { label: '東海道線', key: '東海道' },
  { label: '横須賀線', key: '横須賀' },
  { label: '京葉線', key: '京葉' },
  { label: '常磐線', key: '常磐' },
  { label: '埼京線', key: '埼京' },
  { label: '横浜線', key: '横浜線' },
  { label: '南武線', key: '南武線' },
  { label: '武蔵野線', key: '武蔵野線' },
  { label: '銀座線', key: '銀座線' },
  { label: '丸ノ内線', key: '丸ノ内線' },
  { label: '日比谷線', key: '日比谷線' },
  { label: '東西線', key: '東西線' },
  { label: '千代田線', key: '千代田線' },
  { label: '有楽町線', key: '有楽町線' },
  { label: '半蔵門線', key: '半蔵門線' },
  { label: '南北線', key: '南北線' },
  { label: '副都心線', key: '副都心線' },
  { label: '都営浅草線', key: '浅草線' },
  { label: '都営三田線', key: '三田線' },
  { label: '都営大江戸線', key: '大江戸' },
];

// 主要路線（表示名つき）
export interface MajorLine {
  label: string;
  line: RailLine;
}

// 読み込んだ路線から主要路線を抽出する。
// 直通運転・新幹線の系統は除外し、キーワードに一致する最も簡潔な名称の路線を 1 本選ぶ。
export function selectMajorLines(lines: RailLine[]): MajorLine[] {
  const used = new Set<string>();
  const result: MajorLine[] = [];
  for (const { label, key } of MAJOR_LINE_KEYS) {
    const candidates = lines.filter(
      (l) =>
        l.name.includes(key) &&
        !l.name.includes('直通') &&
        !l.name.includes('新幹線') &&
        l.path.length >= 80 && // 短絡線・支線を除外して本線を選ぶ
        !used.has(l.id),
    );
    if (candidates.length === 0) continue;
    // 名称が最も短いものを代表とする（系統名より路線名を優先）
    candidates.sort((a, b) => a.name.length - b.name.length);
    const line = candidates[0];
    used.add(line.id);
    result.push({ label, line });
  }
  return result;
}

// 路線の長さに応じて 1 方向あたりの編成数を決める
function trainsPerDirection(line: RailLine): number {
  const raw = Math.round(pathLength(line.path, line.isLoop) / TRAIN_SPACING_M);
  return Math.min(TRAIN_MAX_PER_DIR, Math.max(TRAIN_MIN_PER_DIR, raw));
}

// 路線の path に沿って列車を均等配置する（静的モード・実データ初期配置の共通処理）
function seedTrainsAlongLines(sim: TrainSim, lines: RailLine[], speed: number, idPrefix: string): void {
  sim.clearTrains();
  for (const line of lines) {
    const n = line.path.length;
    if (n < 2) continue;
    const per = trainsPerDirection(line);
    for (const direction of [1, -1] as const) {
      for (let k = 0; k < per; k++) {
        const offset = (k / per) * n;
        const segIndex = Math.floor(offset) % n;
        const progress = offset - Math.floor(offset);
        const dirLabel = line.isLoop
          ? direction === 1
            ? '外回り'
            : '内回り'
          : direction === 1
            ? 'A'
            : 'B';
        sim.addTrain({
          id: `${idPrefix}-${line.id}-${direction}-${k}`,
          lineId: line.id,
          segIndex,
          progress,
          direction,
          speedMps: speed,
          label: `${dirLabel}${k + 1}`,
          delaySec: 0,
        });
      }
    }
  }
}

// --- 静的モード（OpenStreetMap 由来データ） -----------------------

// public/osmNetwork.json を読み込んでネットワークを構築する
export async function loadStaticNetwork(): Promise<Network> {
  const res = await fetch('/osmNetwork.json');
  if (!res.ok) {
    throw new Error(`osmNetwork.json の読み込みに失敗: ${res.status}`);
  }
  const data = (await res.json()) as {
    lines: {
      id: string;
      name: string;
      color: Rgb;
      isLoop: boolean;
      path: LngLat[];
      stations?: StationPoint[];
    }[];
    stations: StationPoint[];
  };
  const lines: RailLine[] = data.lines
    .filter((l) => Array.isArray(l.path) && l.path.length >= 2)
    .map((l) => ({
      id: l.id,
      name: l.name,
      color: l.color,
      // 長距離路線が偶然の端点近接で環状判定されるのを防ぐ
      isLoop: l.isLoop && pathLength(l.path, false) < LOOP_MAX_LENGTH_M,
      path: l.path,
      stations: l.stations,
    }));
  return { lines, stations: data.stations ?? [] };
}

// 静的モードの列車を配置する
export function seedStaticTrains(sim: TrainSim, lines: RailLine[]): void {
  seedTrainsAlongLines(sim, lines, STATIC_TRAIN_SPEED_MPS, 'static');
}

// --- 実データモード（ODPT） ---------------------------------------

// #RRGGBB を RGB 配列へ変換する（変換できなければ null）
function hexToRgb(hex?: string): Rgb | null {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const value = parseInt(m[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

// 設定された路線の地理データ（駅順・座標）を ODPT から構築する
export async function loadLiveNetwork(): Promise<Network> {
  const lines: RailLine[] = [];
  const stationMap = new Map<string, StationPoint>();

  for (const config of LIVE_RAILWAYS) {
    try {
      const [railways, stations] = await Promise.all([
        fetchRailway(config.id),
        fetchStations(config.id),
      ]);
      const railway = railways[0];
      if (!railway) continue;

      // 駅ID → 駅情報 の辞書
      const stationById = new Map<string, StationPoint & { id: string }>();
      for (const s of stations) {
        const lng = s['geo:long'];
        const lat = s['geo:lat'];
        if (lng != null && lat != null) {
          stationById.set(s['owl:sameAs'], {
            id: s['owl:sameAs'],
            name: s['dc:title'] ?? s['owl:sameAs'],
            lng,
            lat,
          });
        }
      }

      // 駅順に並べて path と stationIds を作る
      const ordered = [...(railway['odpt:stationOrder'] ?? [])].sort(
        (a, b) => a['odpt:index'] - b['odpt:index'],
      );
      const path: LngLat[] = [];
      const stationIds: string[] = [];
      for (const entry of ordered) {
        const st = stationById.get(entry['odpt:station']);
        if (!st) continue;
        path.push([st.lng, st.lat]);
        stationIds.push(st.id);
        // 全駅リストにも追加
        stationMap.set(st.id, { name: st.name, lng: st.lng, lat: st.lat });
      }
      if (path.length < 2) continue;

      lines.push({
        id: config.id,
        name: railway['dc:title'] ?? config.name,
        color: hexToRgb(railway['odpt:color']) ?? config.color,
        isLoop: config.isLoop,
        path,
        stationIds,
      });
    } catch (err) {
      console.warn('路線データの読み込みに失敗:', config.id, err);
    }
  }

  return { lines, stations: [...stationMap.values()] };
}

// railDirection 文字列から進行方向を推定する（不明なら +1）
function guessDirection(railDirection?: string): 1 | -1 {
  if (!railDirection) return 1;
  if (railDirection.includes('Inner') || railDirection.includes('Inbound')) {
    return -1;
  }
  return 1;
}

// 列車の表示ラベルを組み立てる
function formatLabel(train: OdptTrain): string {
  const number = train['odpt:trainNumber'] ?? '';
  return number ? `列車 ${number}` : '列車';
}

// 実データの列車現在位置を取得して sim を更新する。戻り値は総編成数。
export async function updateLiveTrains(sim: TrainSim, lines: RailLine[]): Promise<number> {
  const activeIds = new Set<string>();
  const results = await Promise.all(
    lines.map((line) => fetchTrains(line.id).catch(() => [] as OdptTrain[])),
  );

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stationIds = line.stationIds;
    if (!stationIds) continue;
    const n = stationIds.length;
    const indexById = new Map<string, number>();
    stationIds.forEach((id, idx) => indexById.set(id, idx));

    for (const train of results[i]) {
      const fromId = train['odpt:fromStation'];
      const toId = train['odpt:toStation'];
      const fromIdx = fromId != null ? indexById.get(fromId) : undefined;
      const toIdx = toId != null ? indexById.get(toId) : undefined;

      let segIndex: number | undefined;
      let direction: 1 | -1 = guessDirection(train['odpt:railDirection']);

      if (fromIdx != null && toIdx != null) {
        segIndex = fromIdx;
        if (line.isLoop) {
          direction = (toIdx - fromIdx + n) % n === 1 ? 1 : -1;
        } else {
          direction = toIdx >= fromIdx ? 1 : -1;
        }
      } else if (fromIdx != null) {
        segIndex = fromIdx;
      } else if (toIdx != null) {
        segIndex = toIdx;
      }

      if (segIndex == null) continue;

      const id = train['owl:sameAs'];
      activeIds.add(id);
      sim.upsertTrain({
        id,
        lineId: line.id,
        segIndex,
        direction,
        speedMps: REAL_NOMINAL_SPEED_MPS,
        label: formatLabel(train),
        delaySec: train['odpt:delay'] ?? 0,
      });
    }
  }

  sim.retainTrains(activeIds);
  return activeIds.size;
}
