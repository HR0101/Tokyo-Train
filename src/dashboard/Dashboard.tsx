import { useEffect, useMemo, useRef, useState } from 'react';
import { DELAY_THRESHOLD_SEC, TrainSim } from '../sim/TrainSim';
import { selectMajorLines } from '../sim/network';
import { displayLineName } from '../sim/arrivals';
import type { RailLine } from '../sim/types';
import type { HudMode } from '../components/Hud';

// 表示更新の間隔（ミリ秒）。CSS トランジションと合わせて滑らかに見せる。
const REFRESH_MS = 200;
// 1 フレームの最大 dt（秒）
const MAX_DT_SEC = 0.5;

// 路線カードのメタ情報
interface CardMeta {
  id: string;
  label: string;
  color: [number, number, number];
  isLoop: boolean;
  stationTicks: number; // 駅数（LIVEモードのストリップ目盛り用）
  isMajor: boolean;
}

// ストリップ上の 1 編成
interface TrainDot {
  id: string;
  fraction: number;
  direction: 1 | -1;
  delayed: boolean;
}

// 1 路線の集計
interface LineAgg extends CardMeta {
  total: number;
  dirA: number;
  dirB: number;
  delayed: number;
  maxDelaySec: number;
  trains: TrainDot[];
}

interface Props {
  sim: TrainSim;
  lines: RailLine[];
  mode: HudMode;
  onFocusLine: (lineId: string) => void;
}

// RGB 配列を CSS の rgb() 文字列にする
function rgb(c: [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export default function Dashboard({ sim, lines, mode, onFocusLine }: Props) {
  const [query, setQuery] = useState('');
  const [aggs, setAggs] = useState<LineAgg[]>([]);
  const lastTimeRef = useRef<number>(0);

  // 全路線のカードメタを作る（主要路線を先頭、残りはパス長の降順）
  const cards = useMemo<CardMeta[]>(() => {
    const majors = selectMajorLines(lines);
    const majorIds = new Set(majors.map((m) => m.line.id));
    const majorCards: CardMeta[] = majors.map((m) => ({
      id: m.line.id,
      label: m.label,
      color: m.line.color,
      isLoop: m.line.isLoop,
      stationTicks: m.line.stationIds?.length ?? 0,
      isMajor: true,
    }));
    const restCards: CardMeta[] = lines
      .filter((l) => !majorIds.has(l.id))
      .sort((a, b) => b.path.length - a.path.length)
      .map((l) => ({
        id: l.id,
        label: displayLineName(l.name),
        color: l.color,
        isLoop: l.isLoop,
        stationTicks: l.stationIds?.length ?? 0,
        isMajor: false,
      }));
    return [...majorCards, ...restCards];
  }, [lines]);

  // 一定間隔で sim を進め、全路線ごとに集計して再描画する
  useEffect(() => {
    lastTimeRef.current = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      let dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;
      if (dt > MAX_DT_SEC) dt = MAX_DT_SEC;

      const states = sim.tick(dt);
      const byLine = new Map<string, LineAgg>();
      for (const c of cards) {
        byLine.set(c.id, { ...c, total: 0, dirA: 0, dirB: 0, delayed: 0, maxDelaySec: 0, trains: [] });
      }
      for (const s of states) {
        const agg = byLine.get(s.lineId);
        if (!agg) continue;
        agg.total += 1;
        if (s.direction === 1) agg.dirA += 1;
        else agg.dirB += 1;
        const delayed = s.delaySec >= DELAY_THRESHOLD_SEC;
        if (delayed) agg.delayed += 1;
        if (s.delaySec > agg.maxDelaySec) agg.maxDelaySec = s.delaySec;
        agg.trains.push({ id: s.id, fraction: s.lineFraction, direction: s.direction, delayed });
      }
      setAggs(cards.map((c) => byLine.get(c.id)!).filter(Boolean));
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [sim, cards]);

  // 検索で絞り込む
  const filtered = useMemo(() => {
    const q = query.trim();
    if (!q) return aggs;
    return aggs.filter((a) => a.label.includes(q));
  }, [aggs, query]);

  // 全体の集計（全路線）
  const totalTrains = aggs.reduce((s, a) => s + a.total, 0);
  const totalDelayed = aggs.reduce((s, a) => s + a.delayed, 0);

  return (
    <div className="dashboard">
      <div className="dash-header">
        <div className="dash-title">
          鉄道ダッシュボード
          <span className={`badge ${mode === 'LIVE' ? 'badge-live' : 'badge-mock'}`}>
            {mode === 'LIVE' ? 'LIVE' : 'SIM'}
          </span>
        </div>
        <div className="dash-summary">
          <div className="dash-sum">
            <span className="dash-sum-num">{totalTrains.toLocaleString('ja-JP')}</span>
            <span className="dash-sum-label">走行編成</span>
          </div>
          <div className="dash-sum">
            <span className="dash-sum-num">{cards.length}</span>
            <span className="dash-sum-label">路線</span>
          </div>
          <div className="dash-sum">
            <span className="dash-sum-num" style={{ color: totalDelayed ? '#ff6b6b' : '#7fe3a8' }}>
              {totalDelayed}
            </span>
            <span className="dash-sum-label">遅延編成</span>
          </div>
        </div>
        <div className="dash-controls">
          <input
            className="dash-search"
            type="text"
            placeholder="路線名で検索…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="dash-hint">
            カードをクリックで 3Dマップの該当路線へ移動
            {query ? `　/　${filtered.length} 路線を表示中` : ''}
          </span>
        </div>
      </div>

      <div className="dash-grid">
        {filtered.map((a) => (
          <button className="dash-card" key={a.id} type="button" onClick={() => onFocusLine(a.id)}>
            <div className="dash-card-head">
              <span className="dash-swatch" style={{ background: rgb(a.color) }} />
              <span className="dash-card-name">{a.label}</span>
              {a.isMajor ? <span className="dash-major">★</span> : null}
              {a.isLoop ? <span className="dash-loop">環状</span> : null}
            </div>

            <div className="dash-card-stats">
              <div className="dash-big">{a.total}</div>
              <div className="dash-dirs">
                <span className="dash-dir dir-a">▶ {a.dirA}</span>
                <span className="dash-dir dir-b">◀ {a.dirB}</span>
              </div>
              <div className={`dash-delay ${a.delayed ? 'is-delayed' : ''}`}>
                {a.delayed ? `${a.delayed}本遅延 / 最大${Math.round(a.maxDelaySec / 60)}分` : '定刻'}
              </div>
            </div>

            <div className="dash-strip">
              {a.stationTicks > 1
                ? Array.from({ length: a.stationTicks }, (_, i) => (
                    <span
                      key={`tick-${i}`}
                      className="dash-tick"
                      style={{ left: `${(i / (a.stationTicks - 1)) * 100}%` }}
                    />
                  ))
                : null}
              {a.trains.map((t) => (
                <span
                  key={t.id}
                  className={`dash-train ${t.direction === 1 ? 'is-a' : 'is-b'} ${t.delayed ? 'is-delayed' : ''}`}
                  style={{ left: `${t.fraction * 100}%`, background: t.delayed ? '#ff5a5a' : rgb(a.color) }}
                />
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
