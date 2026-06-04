import type { OdptTrain, OdptTrainInformation, Rgb } from '../odpt/types';
import {
  fetchRailway,
  fetchStations,
  fetchTrainInformation,
  fetchTrains,
  LIVE_RAILWAYS,
} from '../odpt/client';
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
// 路線名から種別・方向・方面の修飾を取り除き、基幹となる路線名を求める。
// 例:「JR横浜線 各駅停車」「JR横浜線 快速」→「JR横浜線」、
//    「東急東横線: 渋谷 => 横浜」「東急東横線: 横浜 => 渋谷」→「東急東横線」。
// 同じ基幹路線（＝同じ線路）に属する系統をまとめるために使う。
const LINE_TYPE_WORDS =
  /(通勤特急|快速特急|通勤快速|通勤準急|快速急行|区間快速|空港快速|各駅停車|各駅|各停|準急|急行|快速|特急|普通|ライナー|内回り|外回り)/g;

function baseLineName(name: string): string {
  let s = name;
  // 「: 渋谷 => 横浜」「: 中野→西船橋」などの方向・区間表記を落とす
  s = s.replace(/[:：].*$/, '');
  // 種別（各駅停車・快速・急行 …）を落とす
  s = s.replace(LINE_TYPE_WORDS, '');
  // 接頭辞「列車 」と区切り記号・空白を整理する
  s = s.replace(/^列車\s*/, '');
  s = s.replace(/[・•/\s]+/g, '');
  return s.trim();
}

// 静的モードの列車を配置する。
// OSM には同じ線路を共有する系統（各駅停車／快速、上り／下り など）が別路線として
// 含まれており、全てに列車を出すと同じ線路上で列車が重なって見える。そこで同一の
// 基幹路線につき最も区間の多い 1 系統だけを代表として選び、その路線にだけ列車を走らせる。
// 路線ライン自体の描画や乗換案内のグラフは全系統のまま（列車の生成のみを間引く）。
export function seedStaticTrains(sim: TrainSim, lines: RailLine[]): void {
  const repByBase = new Map<string, RailLine>();
  for (const line of lines) {
    const key = baseLineName(line.name) || line.id;
    const current = repByBase.get(key);
    // 代表は最も多くの区間（path 頂点数）を持つ系統を採用する
    if (!current || line.path.length > current.path.length) {
      repByBase.set(key, line);
    }
  }
  seedTrainsAlongLines(sim, [...repByBase.values()], STATIC_TRAIN_SPEED_MPS, 'static');
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

  // 実列車を持つ路線だけを掃除対象にし、ハイブリッド時のシミュレーション列車は残す
  sim.retainTrains(activeIds, new Set(lines.map((l) => l.id)));
  return activeIds.size;
}

// --- ハイブリッドモード（OSM シミュレーション ＋ ODPT 実列車） -----

// ハイブリッドのネットワーク。
// simLines（OSM）はシミュレーション走行、liveLines（ODPT）は実列車で走行させる。
export interface HybridNetwork {
  lines: RailLine[]; // 地図に描く全路線
  stations: StationPoint[];
  simLines: RailLine[]; // シミュレーション対象（OSM 由来）
  liveLines: RailLine[]; // 実列車対象（ODPT で実列車が取得できた路線のみ）
}

// OSM 全路線を土台に、ODPT で実列車が取得できる路線だけを実データに差し替える。
export async function loadHybridNetwork(): Promise<HybridNetwork> {
  const [osm, live] = await Promise.all([loadStaticNetwork(), loadLiveNetwork()]);

  // 実列車が 1 編成以上取得できる ODPT 路線だけを「実列車路線」とする
  // （JR・メトロは現状 0 件のため自動的に除外され、提供が再開すれば自動で対象になる）
  const counts = await Promise.all(
    live.lines.map((l) => fetchTrains(l.id).then((t) => t.length).catch(() => 0)),
  );
  const liveLines = live.lines.filter((_, i) => counts[i] > 0);

  // 実列車路線と重複する OSM 路線を名前で除外し、二重描画を防ぐ
  const liveKeywords = liveLines.map((l) => l.name.replace(/^(都営|東京メトロ|JR)/, '').trim());
  const simLines = osm.lines.filter(
    (o) => !liveKeywords.some((kw) => kw.length > 0 && o.name.includes(kw)),
  );

  const lines = [...simLines, ...liveLines];

  // 駅は OSM 全駅を基本に、実列車路線の駅を名前で補完する
  const stationByName = new Map<string, StationPoint>();
  for (const s of osm.stations) if (!stationByName.has(s.name)) stationByName.set(s.name, s);
  for (const s of live.stations) if (!stationByName.has(s.name)) stationByName.set(s.name, s);

  return { lines, stations: [...stationByName.values()], simLines, liveLines };
}

// --- 運行情報（実データ連携） -------------------------------------

// 運行情報を取得する事業者（提供のある東京メトロ・都営）
const INFO_OPERATORS = ['odpt.Operator:TokyoMetro', 'odpt.Operator:Toei'];

// 運行情報の路線ID → 日本語路線名（OSM 路線名との照合に使う）
const INFO_RAILWAY_NAMES: Record<string, string> = {
  'odpt.Railway:TokyoMetro.Ginza': '銀座線',
  'odpt.Railway:TokyoMetro.Marunouchi': '丸ノ内線',
  'odpt.Railway:TokyoMetro.MarunouchiBranch': '丸ノ内線',
  'odpt.Railway:TokyoMetro.Hibiya': '日比谷線',
  'odpt.Railway:TokyoMetro.Tozai': '東西線',
  'odpt.Railway:TokyoMetro.Chiyoda': '千代田線',
  'odpt.Railway:TokyoMetro.Yurakucho': '有楽町線',
  'odpt.Railway:TokyoMetro.Hanzomon': '半蔵門線',
  'odpt.Railway:TokyoMetro.Namboku': '南北線',
  'odpt.Railway:TokyoMetro.Fukutoshin': '副都心線',
  'odpt.Railway:Toei.Asakusa': '浅草線',
  'odpt.Railway:Toei.Mita': '三田線',
  'odpt.Railway:Toei.Shinjuku': '新宿線',
  'odpt.Railway:Toei.Oedo': '大江戸線',
  'odpt.Railway:Toei.Arakawa': '荒川線',
  'odpt.Railway:Toei.NipporiToneri': '日暮里・舎人ライナー',
};

// 運行情報の深刻度
export type ServiceSeverity = 'normal' | 'delay' | 'suspended';

// 路線の運行状況
export interface ServiceStatus {
  lineName: string; // 日本語路線名
  status: string; // 運行状況（ステータス）
  text: string; // 本文
  severity: ServiceSeverity;
}

// ステータス・本文の文言から深刻度を判定する
function classifyService(status: string, text: string): ServiceSeverity {
  const s = `${status} ${text}`;
  if (s.includes('見合わせ')) return 'suspended';
  if (/遅延|ダイヤ乱れ|遅れ/.test(s) && !/遅延はありません|遅れはありません/.test(s)) {
    return 'delay';
  }
  return 'normal';
}

// 運行情報を取得し、路線名つきの状況リストを返す（提供のある事業者のみ）。
// JR東日本は運行情報を提供していないため対象外。
export async function fetchServiceStatus(): Promise<ServiceStatus[]> {
  const results = await Promise.all(
    INFO_OPERATORS.map((op) => fetchTrainInformation(op).catch(() => [] as OdptTrainInformation[])),
  );
  const out: ServiceStatus[] = [];
  for (const list of results) {
    for (const info of list) {
      const lineName = INFO_RAILWAY_NAMES[info['odpt:railway'] ?? ''];
      if (!lineName) continue;
      const status = info['odpt:trainInformationStatus']?.ja ?? '';
      const text = info['odpt:trainInformationText']?.ja ?? '';
      out.push({ lineName, status, text, severity: classifyService(status, text) });
    }
  }
  return out;
}
