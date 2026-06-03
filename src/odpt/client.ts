import type { OdptRailway, OdptStation, OdptTrain, OdptTrainInformation, Rgb } from './types';

// ODPT API v4 のベースURL
const API_BASE = 'https://api.odpt.org/api/v4';

// 環境変数からアクセストークンを取得する（未設定なら空文字）
const TOKEN = (import.meta.env.VITE_ODPT_TOKEN ?? '').trim();

// 実データモードかどうか（トークンが設定されていれば true）
export function hasToken(): boolean {
  return TOKEN.length > 0;
}

// ODPT API を叩いて配列で返す共通関数
async function fetchOdpt<T>(dataType: string, params: Record<string, string>): Promise<T[]> {
  const query = new URLSearchParams({ ...params, 'acl:consumerKey': TOKEN });
  const url = `${API_BASE}/${dataType}?${query.toString()}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ODPT API エラー (${dataType}): ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T[];
}

// 路線情報（駅順を含む）を取得する
export function fetchRailway(railwayId: string): Promise<OdptRailway[]> {
  return fetchOdpt<OdptRailway>('odpt:Railway', { 'owl:sameAs': railwayId });
}

// 路線に属する駅一覧（座標つき）を取得する
export function fetchStations(railwayId: string): Promise<OdptStation[]> {
  return fetchOdpt<OdptStation>('odpt:Station', { 'odpt:railway': railwayId });
}

// 列車現在位置を取得する
export function fetchTrains(railwayId: string): Promise<OdptTrain[]> {
  return fetchOdpt<OdptTrain>('odpt:Train', { 'odpt:railway': railwayId });
}

// 運行情報を事業者単位で取得する
export function fetchTrainInformation(operatorId: string): Promise<OdptTrainInformation[]> {
  return fetchOdpt<OdptTrainInformation>('odpt:TrainInformation', { 'odpt:operator': operatorId });
}

// 実データモードで可視化する路線の定義
// color はフォールバック用。ODPT 側に色があればそちらを優先する。
export interface RailwayConfig {
  id: string;
  name: string;
  color: Rgb;
  isLoop: boolean;
}

export const LIVE_RAILWAYS: RailwayConfig[] = [
  { id: 'odpt.Railway:JR-East.Yamanote', name: '山手線', color: [154, 205, 50], isLoop: true },
  { id: 'odpt.Railway:JR-East.ChuoRapid', name: '中央線快速', color: [243, 152, 0], isLoop: false },
  { id: 'odpt.Railway:JR-East.KeihinTohokuNegishi', name: '京浜東北線', color: [0, 178, 229], isLoop: false },
  { id: 'odpt.Railway:JR-East.SobuLocal', name: '総武線各停', color: [255, 215, 0], isLoop: false },
  { id: 'odpt.Railway:JR-East.SaikyoKawagoe', name: '埼京線', color: [0, 130, 80], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Ginza', name: '銀座線', color: [255, 153, 0], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Marunouchi', name: '丸ノ内線', color: [227, 0, 12], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Hibiya', name: '日比谷線', color: [137, 145, 145], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Tozai', name: '東西線', color: [0, 168, 221], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Chiyoda', name: '千代田線', color: [0, 188, 138], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Yurakucho', name: '有楽町線', color: [196, 158, 35], isLoop: false },
  { id: 'odpt.Railway:TokyoMetro.Hanzomon', name: '半蔵門線', color: [148, 112, 184], isLoop: false },
  { id: 'odpt.Railway:Toei.Oedo', name: '大江戸線', color: [184, 0, 124], isLoop: false },
  { id: 'odpt.Railway:Toei.Asakusa', name: '浅草線', color: [232, 80, 84], isLoop: false },
];
