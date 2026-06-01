import type { Rgb } from '../odpt/types';

// 経度・緯度のペア（deck.gl と同じ [経度, 緯度] の並び）
export type LngLat = [number, number];

// 駅（地図上に点として表示する全駅）
export interface StationPoint {
  name: string;
  lng: number;
  lat: number;
}

// 路線（描画・走行に使う実線形を持つ）
export interface RailLine {
  id: string;
  name: string;
  color: Rgb;
  isLoop: boolean; // 環状線かどうか
  path: LngLat[]; // 実際の線形（経度緯度の並び）。列車はこの上を進む。
  stationIds?: string[]; // path と同じ並びの駅ID（実データ走行用。OSM静的モードでは未設定）
  stations?: StationPoint[]; // この路線の停車駅（順序つき。駅名ラベル表示に使う）
}

// 1 フレームごとに描画される列車の状態
export interface TrainState {
  id: string;
  lineId: string;
  lineName: string;
  color: Rgb;
  lng: number;
  lat: number;
  label: string;
  delaySec: number;
  lineFraction: number; // 路線上の位置（0〜1）。ダッシュボードのストリップ表示に使う。
  direction: 1 | -1; // 進行方向
  speedMps: number; // 速度（m/s）。到着予測の算出に使う。
}

// 列車の初期化に使うパラメータ
export interface TrainSeed {
  id: string;
  lineId: string;
  segIndex: number; // 現在いる区間の開始点インデックス（path 上）
  progress: number; // 区間内の進捗（0〜1）
  direction: 1 | -1; // 進行方向（+1: path 順方向 / -1: 逆方向）
  speedMps: number; // 速度（m/s）
  label: string;
  delaySec: number;
}
