export type HudMode = 'LOADING' | 'STATIC' | 'LIVE';

interface Props {
  mode: HudMode;
  trainCount: number;
  lineCount: number;
  stationCount: number;
  lastUpdate: string;
  message?: string;
  source: string;
}

// モードに応じたバッジ表示を返す
function badgeOf(mode: HudMode): { text: string; cls: string } {
  if (mode === 'LIVE') return { text: 'LIVE', cls: 'badge-live' };
  if (mode === 'STATIC') return { text: 'OSM', cls: 'badge-mock' };
  return { text: 'LOADING', cls: 'badge-loading' };
}

// 数値を 3 桁区切りで表示
function formatNumber(value: number): string {
  return value.toLocaleString('ja-JP');
}

// 画面左上のダッシュボードパネル
export default function Hud({
  mode,
  trainCount,
  lineCount,
  stationCount,
  lastUpdate,
  message,
  source,
}: Props) {
  const badge = badgeOf(mode);
  return (
    <div className="hud">
      <div className="hud-title">
        東京鉄道デジタルツイン
        <span className={`badge ${badge.cls}`}>{badge.text}</span>
      </div>

      <div className="hud-stats">
        <div className="stat">
          <div className="stat-num">{formatNumber(trainCount)}</div>
          <div className="stat-label">走行編成</div>
        </div>
        <div className="stat">
          <div className="stat-num">{formatNumber(lineCount)}</div>
          <div className="stat-label">路線</div>
        </div>
        <div className="stat">
          <div className="stat-num">{formatNumber(stationCount)}</div>
          <div className="stat-label">駅</div>
        </div>
      </div>

      <div className="hud-update">最終更新: {lastUpdate}</div>
      {message ? <div className="hud-message">{message}</div> : null}

      <div className="hud-foot">データ: {source}</div>
    </div>
  );
}
