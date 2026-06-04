import { nearestStationName, type RouteGraph, type RouteResult } from '../sim/router';

type TimeMode = 'now' | 'depart' | 'arrive';

interface Props {
  graph: RouteGraph | null;
  origin: string;
  dest: string;
  setOrigin: (s: string) => void;
  setDest: (s: string) => void;
  routes: RouteResult[];
  selectedIdx: number;
  setSelectedIdx: (i: number) => void;
  timeMode: TimeMode;
  setTimeMode: (m: TimeMode) => void;
  timeValue: string;
  setTimeValue: (s: string) => void;
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

// "HH:MM" を 0 時からの分に変換する（不正なら null）
function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// 0 時からの分を "H:MM" に変換する（24時間でループ）
function fmtHHMM(totalMin: number): string {
  const m = ((Math.round(totalMin) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${h}:${String(mi).padStart(2, '0')}`;
}

// 1 ルートの出発・到着時刻を所要時間から計算する（時刻表非対応のため目安）
function routeClock(
  route: RouteResult,
  mode: TimeMode,
  baseMin: number | null,
): { depart: string; arrive: string } | null {
  if (baseMin === null || mode === 'now') return null;
  const durMin = Math.max(1, Math.round(route.totalSec / 60));
  if (mode === 'depart') return { depart: fmtHHMM(baseMin), arrive: fmtHHMM(baseMin + durMin) };
  return { depart: fmtHHMM(baseMin - durMin), arrive: fmtHHMM(baseMin) };
}

export default function RoutePanel({
  graph,
  origin,
  dest,
  setOrigin,
  setDest,
  routes,
  selectedIdx,
  setSelectedIdx,
  timeMode,
  setTimeMode,
  timeValue,
  setTimeValue,
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

  // 時刻指定の基準（分）。「今すぐ」または未入力なら null。
  const baseMin = timeMode !== 'now' ? parseHHMM(timeValue) : null;

  // 各指標で最良のルート（バッジ表示用）
  const bestSpeedIdx = routes.length
    ? routes.indexOf(routes.reduce((a, b) => (b.totalSec < a.totalSec ? b : a)))
    : -1;
  const bestTransferIdx = routes.length
    ? routes.indexOf(routes.reduce((a, b) => (b.transfers < a.transfers ? b : a)))
    : -1;
  const bestFareIdx = routes.length
    ? routes.indexOf(routes.reduce((a, b) => (b.fareYen < a.fareYen ? b : a)))
    : -1;

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

      {/* 時刻指定（今すぐ／出発時刻／到着時刻） */}
      <div className="rp-time">
        <div className="rp-time-modes">
          <button
            className={`rp-time-btn${timeMode === 'now' ? ' active' : ''}`}
            type="button"
            onClick={() => setTimeMode('now')}
          >
            今すぐ
          </button>
          <button
            className={`rp-time-btn${timeMode === 'depart' ? ' active' : ''}`}
            type="button"
            onClick={() => setTimeMode('depart')}
          >
            出発時刻
          </button>
          <button
            className={`rp-time-btn${timeMode === 'arrive' ? ' active' : ''}`}
            type="button"
            onClick={() => setTimeMode('arrive')}
          >
            到着時刻
          </button>
        </div>
        {timeMode !== 'now' ? (
          <input
            className="rp-time-input"
            type="time"
            value={timeValue}
            onChange={(e) => setTimeValue(e.target.value)}
          />
        ) : null}
      </div>
      {timeMode !== 'now' ? (
        <div className="rp-time-note">※所要時間からの目安です（発車待ち時間は含みません）</div>
      ) : null}

      {/* ルート候補の一覧 */}
      {ready && routes.length > 0 ? (
        <div className="rp-routes">
          {routes.map((r, i) => {
            const active = i === selectedIdx;
            const clock = routeClock(r, timeMode, baseMin);
            return (
              <div key={i} className={`rp-route-card${active ? ' active' : ''}`}>
                <button
                  className="rp-route-head"
                  type="button"
                  onClick={() => setSelectedIdx(i)}
                >
                  <div className="rp-route-badges">
                    {i === bestSpeedIdx ? <span className="rp-badge speed">⚡最速</span> : null}
                    {i === bestTransferIdx ? <span className="rp-badge few">🔁乗換少</span> : null}
                    {i === bestFareIdx ? <span className="rp-badge fare">💰最安</span> : null}
                  </div>
                  <div className="rp-route-main">
                    <span className="rp-route-time">{formatMin(r.totalSec)}</span>
                    {clock ? (
                      <span className="rp-route-clock">
                        {clock.depart} → {clock.arrive}
                      </span>
                    ) : null}
                  </div>
                  <div className="rp-route-meta">
                    乗換 {r.transfers} 回 ・ {r.stops} 駅 ・ 約 {r.fareYen.toLocaleString()} 円 ・{' '}
                    {(r.distanceM / 1000).toFixed(1)} km
                  </div>
                </button>

                {active ? (
                  <div className="rp-legs">
                    <div className="rp-node">
                      <span className="rp-dot origin" />
                      出発: {r.legs[0].fromName}
                    </div>
                    {r.legs.map((leg, li) => (
                      <div key={`${leg.lineId}-${li}`}>
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
                        {li < r.legs.length - 1 ? (
                          <div className="rp-node transfer">
                            <span className="rp-dot transfer" />
                            {leg.toName} で乗換
                          </div>
                        ) : null}
                      </div>
                    ))}
                    <div className="rp-node">
                      <span className="rp-dot dest" />
                      到着: {r.legs[r.legs.length - 1].toName}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
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
