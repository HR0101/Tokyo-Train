import { useEffect, useMemo, useRef, useState } from 'react';
import TrainMap, { type ReachData } from './map/TrainMap';
import Dashboard from './dashboard/Dashboard';
import StationPanel from './components/StationPanel';
import RoutePanel from './components/RoutePanel';
import Hud, { type HudMode } from './components/Hud';
import { TrainSim } from './sim/TrainSim';
import {
  fetchServiceStatus,
  loadHybridNetwork,
  loadStaticNetwork,
  seedStaticTrains,
  updateLiveTrains,
  type ServiceStatus,
} from './sim/network';
import { buildRouteGraph, buildRouteHighlight, findRoutes, reachableTimes } from './sim/router';
import { hasToken } from './odpt/client';
import type { RailLine, StationPoint, TrainState } from './sim/types';
import type { Rgb } from './odpt/types';

// 実データの再取得間隔（ミリ秒）
const POLL_INTERVAL_MS = 15000;

// データ源の表示ラベル
const SOURCE_OSM = 'OpenStreetMap (ODbL)';
const SOURCE_ODPT = '公共交通オープンデータセンター (ODPT)';

// 現在時刻を「HH:MM:SS」で返す
function currentTimeLabel(): string {
  return new Date().toLocaleTimeString('ja-JP');
}

export default function App() {
  // シミュレーションエンジンは 1 つだけ生成して使い回す
  const simRef = useRef<TrainSim>(new TrainSim());
  const [lines, setLines] = useState<RailLine[]>([]);
  const [stations, setStations] = useState<StationPoint[]>([]);
  const [version, setVersion] = useState(0); // データの版（地図に再構築を伝える）
  const [mode, setMode] = useState<HudMode>('LOADING');
  const [trainCount, setTrainCount] = useState(0);
  const [lastUpdate, setLastUpdate] = useState('-');
  const [message, setMessage] = useState('');
  const [source, setSource] = useState(SOURCE_OSM);
  const [view, setView] = useState<'map' | 'dashboard'>('map');
  const [focusLineId, setFocusLineId] = useState<string | null>(null);
  const [selectedStation, setSelectedStation] = useState<StationPoint | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  const [routeOrigin, setRouteOrigin] = useState('');
  const [routeDest, setRouteDest] = useState('');
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0);
  // 時刻指定（now=今すぐ / depart=出発時刻 / arrive=到着時刻）
  const [timeMode, setTimeMode] = useState<'now' | 'depart' | 'arrive'>('now');
  const [timeValue, setTimeValue] = useState('');
  // 運転席ビュー（前面展望）
  const [cabTrainId, setCabTrainId] = useState<string | null>(null);
  const [cabInfo, setCabInfo] = useState<{ lineName: string; color: Rgb } | null>(null);
  const [boardSignal, setBoardSignal] = useState(0);
  const [reachOrigin, setReachOrigin] = useState<string | null>(null);
  const [disrupted, setDisrupted] = useState<Set<string>>(() => new Set());
  const [serviceStatuses, setServiceStatuses] = useState<ServiceStatus[]>([]);

  // ダッシュボードのカードクリック → 3Dマップで該当路線へフォーカス
  function focusLine(lineId: string) {
    setFocusLineId(lineId);
    setView('map');
  }

  // 路線の運休/復旧を切り替える（経路グラフが再計算され、乗換案内・到達圏に反映される）
  function toggleDisrupt(lineId: string) {
    setDisrupted((prev) => {
      const next = new Set(prev);
      if (next.has(lineId)) next.delete(lineId);
      else next.add(lineId);
      return next;
    });
  }

  // 列車を選んで運転席ビュー（前面展望）に入る
  function pickTrain(train: TrainState) {
    setCabTrainId(train.id);
    setCabInfo({ lineName: train.lineName, color: train.color });
  }

  // 運転席ビューを抜ける
  function exitCab() {
    setCabTrainId(null);
    setCabInfo(null);
  }

  // 運転席ビュー中は周辺の UI を隠す（body クラスで一括制御）
  useEffect(() => {
    document.body.classList.toggle('cab-mode', cabTrainId != null);
    return () => document.body.classList.remove('cab-mode');
  }, [cabTrainId]);

  // フォーカス中の路線名
  const focusedLine = focusLineId ? lines.find((l) => l.id === focusLineId) : undefined;

  // 運転見合わせの路線を OSM 路線にマッチし、実運休として経路から除外する
  const realDisrupted = useMemo(() => {
    const ids = new Set<string>();
    const suspended = serviceStatuses.filter((s) => s.severity === 'suspended');
    if (suspended.length === 0) return ids;
    for (const line of lines) {
      if (suspended.some((s) => line.name.includes(s.lineName))) ids.add(line.id);
    }
    return ids;
  }, [serviceStatuses, lines]);

  // 手動運休 ＋ 実運休（運転見合わせ）を統合する
  const allDisrupted = useMemo(() => {
    if (realDisrupted.size === 0) return disrupted;
    const next = new Set(disrupted);
    for (const id of realDisrupted) next.add(id);
    return next;
  }, [disrupted, realDisrupted]);

  // 経路探索グラフ（路線データから構築。重いので memo 化）
  const graph = useMemo(
    () => (lines.length ? buildRouteGraph(lines, allDisrupted) : null),
    [lines, allDisrupted],
  );
  const linesById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);

  // 到達圏（出発駅から各駅への所要時間）。出発駅が選ばれている間だけ計算する。
  const reach = useMemo<ReachData | null>(() => {
    if (!graph || !reachOrigin) return null;
    return { origin: reachOrigin, times: reachableTimes(graph, reachOrigin) };
  }, [graph, reachOrigin]);

  // 出発・目的が揃ったら複数の経路候補を探索する
  const routes = useMemo(() => {
    if (!graph || !routeOrigin.trim() || !routeDest.trim()) return [];
    return findRoutes(graph, routeOrigin.trim(), routeDest.trim(), { maxRoutes: 3 });
  }, [graph, routeOrigin, routeDest]);

  // 出発・目的を変えたら選択中ルートを先頭（最速）に戻す
  useEffect(() => {
    setSelectedRouteIdx(0);
  }, [routeOrigin, routeDest]);

  // 地図ハイライト等に使う「選択中」のルート
  const route = routes[selectedRouteIdx] ?? routes[0] ?? null;

  // 経路の地図ハイライト
  const routeHighlight = useMemo(() => {
    if (!route || !graph) return null;
    return buildRouteHighlight(route, graph, linesById);
  }, [route, graph, linesById]);

  // 駅情報パネルから出発／目的に設定する
  function setRouteEndpoint(name: string, which: 'origin' | 'dest') {
    if (which === 'origin') setRouteOrigin(name);
    else setRouteDest(name);
    setRouteOpen(true);
    setView('map');
    setSelectedStation(null);
    setFocusLineId(null);
  }

  useEffect(() => {
    const sim = simRef.current;
    let cancelled = false;
    let timer: number | undefined;

    // 静的モード（OpenStreetMap）を開始する
    async function startStatic(note: string) {
      setSource(SOURCE_OSM);
      setMessage(note || '全駅データ（OpenStreetMap）を読み込み中…');
      const network = await loadStaticNetwork();
      if (cancelled) return;
      sim.setLines(network.lines);
      seedStaticTrains(sim, network.lines);
      setLines(network.lines);
      setStations(network.stations);
      setVersion((v) => v + 1);
      setMode('STATIC');
      setTrainCount(sim.trainCount());
      setLastUpdate(currentTimeLabel());
      setMessage('');
    }

    // ハイブリッドモード（OSM 全路線シミュレーション ＋ ODPT 実列車）を開始する
    async function startHybrid() {
      setSource(`${SOURCE_OSM} ＋ ${SOURCE_ODPT}`);
      setMessage('全路線データ ＋ 実データ（ODPT）を読み込み中…');
      const network = await loadHybridNetwork();
      if (cancelled) return;
      if (network.lines.length === 0) {
        throw new Error('路線データを取得できませんでした');
      }
      sim.setLines(network.lines);
      // OSM 路線はシミュレーションで走らせる（実列車路線は ODPT で上書きする）
      seedStaticTrains(sim, network.simLines);
      setLines(network.lines);
      setStations(network.stations);
      setVersion((v) => v + 1);
      setMode('LIVE');
      setTrainCount(sim.trainCount());
      setLastUpdate(currentTimeLabel());

      // 実列車を提供する路線が無い場合（深夜帯など）はシミュレーションのみで表示する
      if (network.liveLines.length === 0) {
        setMessage(
          '現在、実列車を提供する路線がありません（深夜帯など）。全路線シミュレーションで表示中です。',
        );
        return;
      }
      setMessage('');

      // 実列車路線の現在位置を定期取得して上書きする
      const poll = async () => {
        try {
          await updateLiveTrains(sim, network.liveLines);
          if (cancelled) return;
          setTrainCount(sim.trainCount());
          setLastUpdate(currentTimeLabel());
        } catch (err) {
          if (cancelled) return;
          setMessage(`実列車データの取得に失敗: ${(err as Error).message}`);
        }
      };
      await poll();
      timer = window.setInterval(poll, POLL_INTERVAL_MS);
    }

    // トークンの有無でモードを切り替える
    if (hasToken()) {
      startHybrid().catch((err) => {
        if (cancelled) return;
        // 実データに失敗したら静的モードへフォールバック
        startStatic(`実データ取得に失敗したため OSM 表示に切替えました（${(err as Error).message}）`).catch(
          (e) => setMessage(`データ読み込みに失敗: ${(e as Error).message}`),
        );
      });
    } else {
      startStatic('').catch((err) => setMessage(`データ読み込みに失敗: ${(err as Error).message}`));
    }

    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, []);

  // 運行情報（実データ）を定期取得する（トークンがあるときのみ）
  useEffect(() => {
    if (!hasToken()) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const statuses = await fetchServiceStatus();
        if (!cancelled) setServiceStatuses(statuses);
      } catch {
        /* 運行情報の取得失敗は無視（他機能に影響させない） */
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // 運行情報のうち「乱れているもの」だけを抽出（パネル表示用）
  const tokenAvailable = hasToken();
  const serviceIssues = serviceStatuses.filter((s) => s.severity !== 'normal');

  return (
    <>
      {/* ビュー切替 */}
      <div className="view-toggle">
        <button
          className={view === 'map' ? 'active' : ''}
          onClick={() => setView('map')}
          type="button"
        >
          3Dマップ
        </button>
        <button
          className={view === 'dashboard' ? 'active' : ''}
          onClick={() => setView('dashboard')}
          type="button"
        >
          ダッシュボード
        </button>
      </div>

      {view === 'map' ? (
        <>
          <TrainMap
            sim={simRef.current}
            lines={lines}
            stations={stations}
            version={version}
            focusLineId={focusLineId}
            onStationClick={setSelectedStation}
            route={routeHighlight}
            reach={reach}
            disruptedLineIds={allDisrupted}
            cabTrainId={cabTrainId}
            onTrainPick={pickTrain}
            onCabExit={exitCab}
            boardSignal={boardSignal}
          />
          {selectedStation ? (
            <StationPanel
              station={selectedStation}
              lines={lines}
              sim={simRef.current}
              mode={mode}
              onClose={() => setSelectedStation(null)}
              onFocusLine={focusLine}
              onSetOrigin={(name) => setRouteEndpoint(name, 'origin')}
              onSetDest={(name) => setRouteEndpoint(name, 'dest')}
              onShowReach={(name) => {
                // 到達圏モードに入る（経路・フォーカスとは排他）
                setReachOrigin(name);
                setSelectedStation(null);
                setFocusLineId(null);
                setRouteOpen(false);
                setRouteOrigin('');
                setRouteDest('');
              }}
            />
          ) : null}
          {focusedLine && !routeHighlight && !reach ? (
            <div className="focus-banner">
              <span className="focus-dot" style={{ background: `rgb(${focusedLine.color[0]},${focusedLine.color[1]},${focusedLine.color[2]})` }} />
              <span className="focus-name">{focusedLine.name}</span>
              <button
                className={`focus-disrupt${disrupted.has(focusedLine.id) ? ' active' : ''}`}
                type="button"
                onClick={() => toggleDisrupt(focusedLine.id)}
              >
                {disrupted.has(focusedLine.id) ? '✓ 運休中（復旧）' : '🚫 運休にする'}
              </button>
              <button className="focus-clear" type="button" onClick={() => setFocusLineId(null)}>
                ✕ 解除
              </button>
            </div>
          ) : null}
          {disrupted.size > 0 ? (
            <div className="disrupt-banner">
              <div className="disrupt-head">
                <span className="disrupt-title">🚫 運休中 {disrupted.size} 路線</span>
                <button
                  className="disrupt-clear"
                  type="button"
                  onClick={() => setDisrupted(new Set())}
                >
                  全復旧
                </button>
              </div>
              <div className="disrupt-list">
                {[...disrupted].map((id) => {
                  const l = linesById.get(id);
                  if (!l) return null;
                  return (
                    <button
                      key={id}
                      className="disrupt-chip"
                      type="button"
                      onClick={() => toggleDisrupt(id)}
                      title="クリックで復旧"
                    >
                      <span
                        className="disrupt-chip-dot"
                        style={{ background: `rgb(${l.color[0]},${l.color[1]},${l.color[2]})` }}
                      />
                      {l.name} ✕
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
          {reach ? (
            <div className="reach-banner">
              <div className="reach-head">
                <span className="reach-title">到達圏 — {reach.origin} から</span>
                <button className="reach-clear" type="button" onClick={() => setReachOrigin(null)}>
                  ✕ 解除
                </button>
              </div>
              <div className="reach-legend">
                <span><i style={{ background: 'rgb(80,220,120)' }} />〜15分</span>
                <span><i style={{ background: 'rgb(200,220,80)' }} />〜30分</span>
                <span><i style={{ background: 'rgb(245,165,70)' }} />〜45分</span>
                <span><i style={{ background: 'rgb(240,95,80)' }} />〜60分</span>
                <span><i style={{ background: 'rgb(150,90,120)' }} />60分超</span>
              </div>
            </div>
          ) : null}
          {routeOpen ? (
            <RoutePanel
              graph={graph}
              origin={routeOrigin}
              dest={routeDest}
              setOrigin={setRouteOrigin}
              setDest={setRouteDest}
              routes={routes}
              selectedIdx={selectedRouteIdx}
              setSelectedIdx={setSelectedRouteIdx}
              timeMode={timeMode}
              setTimeMode={setTimeMode}
              timeValue={timeValue}
              setTimeValue={setTimeValue}
              onFocusLeg={focusLine}
              onClose={() => {
                // パネルを閉じ、経路ハイライトもクリアして通常表示に戻す
                setRouteOpen(false);
                setRouteOrigin('');
                setRouteDest('');
              }}
            />
          ) : (
            <>
              <button
                className="cab-launch"
                type="button"
                onClick={() => setBoardSignal((s) => s + 1)}
                title="画面の中心に近い走行中の列車に乗ります"
              >
                🚃 運転席ビュー
              </button>
              <button className="route-launch" type="button" onClick={() => setRouteOpen(true)}>
                🧭 乗換案内
              </button>
            </>
          )}
          {cabTrainId && cabInfo ? (
            <div className="cab-banner">
              <span
                className="cab-dot"
                style={{
                  background: `rgb(${cabInfo.color[0]},${cabInfo.color[1]},${cabInfo.color[2]})`,
                }}
              />
              <span className="cab-line">{cabInfo.lineName}</span>
              <span className="cab-tag">運転席ビュー</span>
              <button className="cab-exit" type="button" onClick={exitCab}>
                ✕ 終了
              </button>
            </div>
          ) : null}
          {!routeOpen ? (
            <Hud
              mode={mode}
              trainCount={trainCount}
              lineCount={lines.length}
              stationCount={stations.length}
              lastUpdate={lastUpdate}
              message={message}
              source={source}
            />
          ) : null}
          {tokenAvailable && serviceIssues.length > 0 ? (
            <div className="service-panel">
              <div className="service-head">⚠ 運行情報（メトロ・都営）</div>
              <div className="service-list">
                {serviceIssues.map((s, i) => (
                  <div key={`${s.lineName}-${i}`} className={`service-item ${s.severity}`}>
                    <span className="service-line">{s.lineName}</span>
                    <span className="service-status">
                      {s.severity === 'suspended' ? '運転見合わせ' : s.status || '遅延・乱れ'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </>
      ) : (
        <Dashboard sim={simRef.current} lines={lines} mode={mode} onFocusLine={focusLine} />
      )}
    </>
  );
}
