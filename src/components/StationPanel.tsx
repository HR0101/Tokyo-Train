import { useEffect, useMemo, useState } from 'react';
import { TrainSim } from '../sim/TrainSim';
import { findServingLines, nextArrivals, type Arrival } from '../sim/arrivals';
import type { RailLine, StationPoint } from '../sim/types';
import type { HudMode } from './Hud';

// 到着予測の更新間隔（ミリ秒）
const REFRESH_MS = 1000;
// 表示する到着予測の最大件数
const MAX_ARRIVALS = 12;

interface Props {
  station: StationPoint;
  lines: RailLine[];
  sim: TrainSim;
  mode: HudMode;
  onClose: () => void;
  onFocusLine: (lineId: string) => void;
  onSetOrigin?: (name: string) => void;
  onSetDest?: (name: string) => void;
  onShowReach?: (name: string) => void;
}

// RGB を CSS 文字列に
function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// 秒を「○分○秒」または「○秒」に整形
function formatEta(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}秒`;
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

export default function StationPanel({
  station,
  lines,
  sim,
  mode,
  onClose,
  onFocusLine,
  onSetOrigin,
  onSetDest,
  onShowReach,
}: Props) {
  // 乗り入れ路線（駅が変わったときだけ計算）
  const serving = useMemo(() => findServingLines(station, lines), [station, lines]);
  const [arrivals, setArrivals] = useState<Arrival[]>([]);

  // 到着予測を一定間隔で更新する（sim は地図側が進めるので tick(0) で現在値だけ読む）
  useEffect(() => {
    const update = () => {
      const trains = sim.tick(0);
      setArrivals(nextArrivals(serving, trains).slice(0, MAX_ARRIVALS));
    };
    update();
    const timer = window.setInterval(update, REFRESH_MS);
    return () => clearInterval(timer);
  }, [serving, sim]);

  return (
    <div className="station-panel">
      <div className="sp-head">
        <div className="sp-name">{station.name}</div>
        <button className="sp-close" type="button" onClick={onClose}>
          ✕
        </button>
      </div>

      <div className="sp-route-actions">
        <button className="sp-route-btn origin" type="button" onClick={() => onSetOrigin?.(station.name)}>
          ここから出発
        </button>
        <button className="sp-route-btn dest" type="button" onClick={() => onSetDest?.(station.name)}>
          ここへ行く
        </button>
      </div>

      {onShowReach ? (
        <button className="sp-reach-btn" type="button" onClick={() => onShowReach(station.name)}>
          ⏱ ここからの到達圏を見る
        </button>
      ) : null}

      <div className="sp-section-title">乗り入れ・乗り換え路線（{serving.length}）</div>
      {serving.length > 0 ? (
        <div className="sp-lines">
          {serving.map((s) => (
            <button
              className="sp-chip"
              key={s.lineId}
              type="button"
              onClick={() => onFocusLine(s.lineId)}
              title="クリックで路線をフォーカス"
            >
              <span className="sp-chip-dot" style={{ background: rgb(s.color) }} />
              {s.displayName}
            </button>
          ))}
        </div>
      ) : (
        <div className="sp-empty">この駅に対応する路線が見つかりませんでした</div>
      )}

      <div className="sp-section-title">
        まもなく到着（予測）
        <span className="sp-badge">{mode === 'LIVE' ? 'LIVE' : 'SIM'}</span>
      </div>
      {arrivals.length > 0 ? (
        <div className="sp-arrivals">
          {arrivals.map((a, i) => (
            <button
              className="sp-arrival"
              key={`${a.lineId}-${a.dirLabel}-${i}`}
              type="button"
              onClick={() => onFocusLine(a.lineId)}
            >
              <span className="sp-arr-bar" style={{ background: rgb(a.color) }} />
              <span className="sp-arr-line">{a.displayName}</span>
              <span className="sp-arr-dir">{a.dirLabel}</span>
              <span className="sp-arr-eta">{formatEta(a.etaSec)}</span>
            </button>
          ))}
        </div>
      ) : (
        <div className="sp-empty">接近中の列車はありません</div>
      )}

      <div className="sp-note">
        ※ 到着予測は現在の列車位置からの推定です（時刻表ではありません）。
      </div>
    </div>
  );
}
