import { nearestStationName, type RouteGraph, type RouteResult } from '../sim/router';

interface Props {
  graph: RouteGraph | null;
  origin: string;
  dest: string;
  setOrigin: (s: string) => void;
  setDest: (s: string) => void;
  route: RouteResult | null;
  onClose: () => void;
  onFocusLeg?: (lineId: string) => void;
}

// RGB を CSS 文字列に
function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// 秒を「約N分」に
function formatMin(sec: number): string {
  return `${Math.max(1, Math.round(sec / 60))}分`;
}

export default function RoutePanel({
  graph,
  origin,
  dest,
  setOrigin,
  setDest,
  route,
  onClose,
  onFocusLeg,
}: Props) {
  // 現在地の最寄駅を出発駅にする
  const locate = () => {
    if (!graph || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const name = nearestStationName(graph, pos.coords.longitude, pos.coords.latitude);
        if (name) setOrigin(name);
      },
      () => {
        /* 取得失敗時は何もしない */
      },
    );
  };

  const swap = () => {
    setOrigin(dest);
    setDest(origin);
  };

  const ready = origin.trim() !== '' && dest.trim() !== '';

  return (
    <div className="route-panel">
      <div className="rp-head">
        <div className="rp-title">乗換案内</div>
        <button className="rp-close" type="button" onClick={onClose}>
          ✕
        </button>
      </div>

      <datalist id="rp-stations">
        {graph?.stationNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>

      <div className="rp-field">
        <span className="rp-pin origin">出発</span>
        <input
          className="rp-input"
          list="rp-stations"
          value={origin}
          placeholder="出発駅"
          onChange={(e) => setOrigin(e.target.value)}
        />
        <button className="rp-locate" type="button" onClick={locate} title="現在地の最寄駅">
          📍
        </button>
      </div>

      <div className="rp-swap-row">
        <button className="rp-swap" type="button" onClick={swap} title="出発と目的を入れ替え">
          ⇅
        </button>
      </div>

      <div className="rp-field">
        <span className="rp-pin dest">到着</span>
        <input
          className="rp-input"
          list="rp-stations"
          value={dest}
          placeholder="目的駅"
          onChange={(e) => setDest(e.target.value)}
        />
      </div>

      {/* 結果 */}
      {ready && route ? (
        <div className="rp-result">
          <div className="rp-summary">
            <span className="rp-total">{formatMin(route.totalSec)}</span>
            <span className="rp-meta">
              乗換 {route.transfers} 回 / {route.stops} 駅
            </span>
          </div>
          <div className="rp-legs">
            <div className="rp-node">
              <span className="rp-dot origin" />
              出発: {route.legs[0].fromName}
            </div>
            {route.legs.map((leg, i) => (
              <div key={`${leg.lineId}-${i}`}>
                <button
                  className="rp-leg"
                  type="button"
                  onClick={() => onFocusLeg?.(leg.lineId)}
                >
                  <span className="rp-leg-bar" style={{ background: rgb(leg.color) }} />
                  <span className="rp-leg-body">
                    <span className="rp-leg-line">
                      {leg.lineName}
                      {leg.terminalName ? `（${leg.terminalName}方面）` : ''}
                    </span>
                    <span className="rp-leg-sub">
                      {leg.fromName} → {leg.toName} ・ {leg.hops}駅 ・ 約{formatMin(leg.sec)}
                    </span>
                  </span>
                </button>
                {i < route.legs.length - 1 ? (
                  <div className="rp-node transfer">
                    <span className="rp-dot transfer" />
                    {leg.toName} で乗換
                  </div>
                ) : null}
              </div>
            ))}
            <div className="rp-node">
              <span className="rp-dot dest" />
              到着: {route.legs[route.legs.length - 1].toName}
            </div>
          </div>
        </div>
      ) : ready ? (
        <div className="rp-empty">経路が見つかりませんでした</div>
      ) : (
        <div className="rp-hint">
          出発駅と目的駅を入力すると経路を表示します。地図の駅をクリックして「出発／到着」に設定もできます。
        </div>
      )}
    </div>
  );
}
