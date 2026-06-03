// ODPT API のレスポンス型（利用する項目のみ定義）

// RGB カラー（deck.gl 用）
export type Rgb = [number, number, number];

// 駅
export interface OdptStation {
  'owl:sameAs': string; // 駅ID 例: odpt.Station:JR-East.Yamanote.Tokyo
  'dc:title'?: string; // 駅名（日本語）
  'odpt:railway'?: string; // 所属路線ID
  'geo:lat'?: number; // 緯度
  'geo:long'?: number; // 経度
}

// 路線の駅順エントリ
export interface OdptStationOrder {
  'odpt:station': string; // 駅ID
  'odpt:index': number; // 並び順
}

// 路線（駅順を含む）
export interface OdptRailway {
  'owl:sameAs': string; // 路線ID
  'dc:title'?: string; // 路線名
  'odpt:color'?: string; // 路線カラー（#RRGGBB）
  'odpt:stationOrder'?: OdptStationOrder[];
}

// 列車現在位置
export interface OdptTrain {
  'owl:sameAs': string; // 列車ID
  'odpt:railway': string; // 路線ID
  'odpt:trainNumber'?: string; // 列車番号
  'odpt:trainType'?: string; // 種別
  'odpt:fromStation'?: string; // 直前に発車した駅
  'odpt:toStation'?: string; // 次に到着する駅
  'odpt:railDirection'?: string; // 進行方向
  'odpt:delay'?: number; // 遅延（秒）
  'odpt:carComposition'?: number; // 編成両数
}

// 運行情報（遅延・運転見合わせなど）
export interface OdptTrainInformation {
  'owl:sameAs': string;
  'odpt:operator'?: string; // 事業者ID
  'odpt:railway'?: string; // 路線ID（平常時は省略されることもある）
  'odpt:trainInformationStatus'?: { ja?: string; en?: string }; // 運行状況（平常時は無いことが多い）
  'odpt:trainInformationText'?: { ja?: string; en?: string }; // 運行情報の本文
}
