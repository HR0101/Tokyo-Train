import { useEffect, useMemo, useRef, useState } from 'react';
import TrainMap from './map/TrainMap';
import Dashboard from './dashboard/Dashboard';
import StationPanel from './components/StationPanel';
import RoutePanel from './components/RoutePanel';
import Hud, { type HudMode } from './components/Hud';
import { TrainSim } from './sim/TrainSim';
import { loadLiveNetwork, loadStaticNetwork, seedStaticTrains, updateLiveTrains } from './sim/network';
import { buildRouteGraph, buildRouteHighlight, findRoute } from './sim/router';
import { hasToken } from './odpt/client';
import type { RailLine, StationPoint } from './sim/types';

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

  // ダッシュボードのカードクリック → 3Dマップで該当路線へフォーカス
  function focusLine(lineId: string) {
    setFocusLineId(lineId);
    setView('map');
  }

  // フォーカス中の路線名
  const focusedLine = focusLineId ? lines.find((l) => l.id === focusLineId) : undefined;

  // 経路探索グラフ（路線データから構築。重いので memo 化）
  const graph = useMemo(() => (lines.length ? buildRouteGraph(lines) : null), [lines]);
  const linesById = useMemo(() => new Map(lines.map((l) => [l.id, l])), [lines]);

  // 出発・目的が揃ったら経路を探索
  const route = useMemo(() => {
    if (!graph || !routeOrigin.trim() || !routeDest.trim()) return null;
    return findRoute(graph, routeOrigin.trim(), routeDest.trim());
  }, [graph, routeOrigin, routeDest]);

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

    // 実データモード（ODPT）を開始する
    async function startLive() {
      setSource(SOURCE_ODPT);
      setMessage('実データ（ODPT）を読み込み中…');
      const network = await loadLiveNetwork();
      if (cancelled) return;
      if (network.lines.length === 0) {
        throw new Error('路線データを取得できませんでした');
      }
      sim.setLines(network.lines);
      setLines(network.lines);
      setStations(network.stations);
      setVersion((v) => v + 1);
      setMode('LIVE');

      // 列車現在位置を定期取得する
      const poll = async () => {
        try {
          const count = await updateLiveTrains(sim, network.lines);
          if (cancelled) return;
          setTrainCount(count);
          setLastUpdate(currentTimeLabel());
          setMessage('');
        } catch (err) {
          if (cancelled) return;
          setMessage(`列車データの取得に失敗: ${(err as Error).message}`);
        }
      };
      await poll();
      timer = window.setInterval(poll, POLL_INTERVAL_MS);
    }

    // トークンの有無でモードを切り替える
    if (hasToken()) {
      startLive().catch((err) => {
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
            />
          ) : null}
          {focusedLine && !routeHighlight ? (
            <div className="focus-banner">
              <span className="focus-dot" style={{ background: `rgb(${focusedLine.color[0]},${focusedLine.color[1]},${focusedLine.color[2]})` }} />
              <span className="focus-name">{focusedLine.name}</span>
              <button className="focus-clear" type="button" onClick={() => setFocusLineId(null)}>
                ✕ 解除
              </button>
            </div>
          ) : null}
          {routeOpen ? (
            <RoutePanel
              graph={graph}
              origin={routeOrigin}
              dest={routeDest}
              setOrigin={setRouteOrigin}
              setDest={setRouteDest}
              route={route}
              onClose={() => {
                // パネルを閉じ、経路ハイライトもクリアして通常表示に戻す
                setRouteOpen(false);
                setRouteOrigin('');
                setRouteDest('');
              }}
            />
          ) : (
            <button className="route-launch" type="button" onClick={() => setRouteOpen(true)}>
              🧭 乗換案内
            </button>
          )}
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
        </>
      ) : (
        <Dashboard sim={simRef.current} lines={lines} mode={mode} onFocusLine={focusLine} />
      )}
    </>
  );
}
