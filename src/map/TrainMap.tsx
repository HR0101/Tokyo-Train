import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import { MapboxOverlay } from '@deck.gl/mapbox';
import { PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import 'maplibre-gl/dist/maplibre-gl.css';
import { DELAY_THRESHOLD_SEC, TrainSim } from '../sim/TrainSim';
import { distanceMeters } from '../sim/geo';
import type { RouteHighlight } from '../sim/router';
import type { LngLat, RailLine, StationPoint, TrainState } from '../sim/types';

// 地図の初期表示（都心を3Dで近接俯瞰。引くと首都圏全体が見える）
const INITIAL_CENTER: [number, number] = [139.764, 35.681];
const INITIAL_ZOOM = 13.2;
const INITIAL_PITCH = 62;
const INITIAL_BEARING = -25;

// CARTO の無料ダークスタイル（APIキー不要）
const DARK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';

// 3D 列車（直方体）の寸法（メートル）。線路方向に長い箱。
const TRAIN_LEN_M = 240; // 進行方向の長さ
const TRAIN_WID_M = 60; // 幅
const TRAIN_HGT_M = 60; // 高さ

// 単位ボックスのメッシュ（x:幅[-0.5,0.5] / y:長さ[-0.5,0.5] / z:高さ[0,1]、底面を地面に置く）
function makeBoxMesh() {
  const faces = [
    { n: [0, 0, 1], v: [[-0.5, -0.5, 1], [0.5, -0.5, 1], [0.5, 0.5, 1], [-0.5, 0.5, 1]] },
    { n: [0, 0, -1], v: [[-0.5, 0.5, 0], [0.5, 0.5, 0], [0.5, -0.5, 0], [-0.5, -0.5, 0]] },
    { n: [0, 1, 0], v: [[-0.5, 0.5, 0], [-0.5, 0.5, 1], [0.5, 0.5, 1], [0.5, 0.5, 0]] },
    { n: [0, -1, 0], v: [[0.5, -0.5, 0], [0.5, -0.5, 1], [-0.5, -0.5, 1], [-0.5, -0.5, 0]] },
    { n: [1, 0, 0], v: [[0.5, 0.5, 0], [0.5, 0.5, 1], [0.5, -0.5, 1], [0.5, -0.5, 0]] },
    { n: [-1, 0, 0], v: [[-0.5, -0.5, 0], [-0.5, -0.5, 1], [-0.5, 0.5, 1], [-0.5, 0.5, 0]] },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  let base = 0;
  for (const f of faces) {
    for (const vert of f.v) {
      positions.push(vert[0], vert[1], vert[2]);
      normals.push(f.n[0], f.n[1], f.n[2]);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return {
    attributes: {
      positions: { value: new Float32Array(positions), size: 3 },
      normals: { value: new Float32Array(normals), size: 3 },
    },
    indices: { value: new Uint16Array(indices), size: 1 },
  };
}

const TRAIN_MESH = makeBoxMesh();

// dt の上限（タブ非表示から復帰したときの飛びを抑える）
const MAX_DT_SEC = 0.5;

// フォーカス路線の駅とみなす、経路からの最大距離（メートル）
const STATION_MATCH_M = 180;
// 駅ラベルのフォント（日本語対応）
const LABEL_FONT = "'Hiragino Kaku Gothic ProN','Yu Gothic',sans-serif";

// 経路（path）の近傍にある駅を全駅から抽出する。
// フォーカス時に「その路線の駅」を求めて駅名ラベルを出すために使う。
function stationsNearPath(path: LngLat[], stations: StationPoint[]): StationPoint[] {
  if (path.length < 2) return [];
  // 経路の外接矩形（余白つき）で粗く絞り込む
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of path) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const margin = 0.004; // 約 400m
  const result: StationPoint[] = [];
  for (const s of stations) {
    if (s.lng < minLng - margin || s.lng > maxLng + margin) continue;
    if (s.lat < minLat - margin || s.lat > maxLat + margin) continue;
    const sp: LngLat = [s.lng, s.lat];
    let best = Infinity;
    for (let i = 0; i < path.length; i++) {
      const d = distanceMeters(sp, path[i]);
      if (d < best) {
        best = d;
        if (best < STATION_MATCH_M) break; // 閾値内が見つかれば打ち切り
      }
    }
    if (best < STATION_MATCH_M) result.push(s);
  }
  return result;
}

interface Props {
  sim: TrainSim;
  lines: RailLine[];
  stations: StationPoint[];
  version: number; // データ更新時に静的レイヤを作り直すためのキー
  focusLineId?: string | null; // フォーカス中の路線ID（強調＋カメラ移動）
  onStationClick?: (station: StationPoint) => void; // 駅クリック時のコールバック
  route?: RouteHighlight | null; // 乗換案内の経路ハイライト
}

// 路線ポリラインの描画データ
interface PathDatum {
  id: string;
  path: LngLat[];
  color: [number, number, number];
}

// 経路ハイライトのマーカー型
type RouteMarker = RouteHighlight['markers'][number];
// 経路ハイライトの区間型
type RouteSegment = RouteHighlight['segments'][number];

export default function TrainMap({
  sim,
  lines,
  stations,
  version,
  focusLineId,
  onStationClick,
  route,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const frameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  // フォーカス中の路線ID（アニメーションループから参照する）
  const focusRef = useRef<string | null>(focusLineId ?? null);
  // フォーカス路線の近接駅（駅名ラベル用）
  const focusStationsRef = useRef<StationPoint[]>([]);
  // 駅クリックのコールバック（アニメーションループ内のレイヤから参照する）
  const onStationClickRef = useRef(onStationClick);
  onStationClickRef.current = onStationClick;
  // 乗換案内の経路ハイライト（アニメーションループから参照する）
  const routeRef = useRef<RouteHighlight | null>(route ?? null);
  // 静的データ（路線・駅）は版が変わったときだけ作り直す
  const staticRef = useRef<{ paths: PathDatum[]; stations: StationPoint[] }>({
    paths: [],
    stations: [],
  });

  // 地図とオーバーレイの初期化（1 回のみ）
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: DARK_STYLE,
      center: INITIAL_CENTER,
      zoom: INITIAL_ZOOM,
      pitch: INITIAL_PITCH,
      bearing: INITIAL_BEARING,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }) as unknown as maplibregl.IControl,
      'bottom-left',
    );

    const overlay = new MapboxOverlay({
      interleaved: true,
      layers: [],
      // 列車・駅にカーソルを合わせたときのツールチップ
      getTooltip: (info: { object?: TrainState | StationPoint }) => {
        const o = info.object;
        if (!o) return null;
        const boxStyle = {
          background: 'rgba(8,12,22,0.92)',
          color: '#e5f2ff',
          fontSize: '12px',
          padding: '7px 10px',
          borderRadius: '8px',
          border: '1px solid rgba(90,130,200,0.4)',
        };
        if ('lineName' in o) {
          // 列車
          const delayText =
            o.delaySec >= DELAY_THRESHOLD_SEC
              ? `${Math.round(o.delaySec / 60)} 分遅れ`
              : o.delaySec > 0
                ? `${o.delaySec} 秒遅れ`
                : '定刻';
          return {
            html: `<div style="font-weight:700;margin-bottom:2px">${o.lineName}　${o.label}</div>
                   <div style="color:${o.delaySec >= DELAY_THRESHOLD_SEC ? '#ff6b6b' : '#7fe3a8'}">${delayText}</div>`,
            style: boxStyle,
          };
        }
        // 駅
        return { html: `<div style="font-weight:700">${o.name}</div>`, style: boxStyle };
      },
    });
    map.addControl(overlay as unknown as maplibregl.IControl);

    // 3D ビルを追加してデジタルツインらしい立体感を出す
    map.on('load', () => {
      try {
        // 既存の平面ビルレイヤを隠す
        for (const id of ['building', 'building-top']) {
          if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
        }
        // ラベル（symbol）の下に 3D ビルを挿入してラベルを上に保つ
        const firstSymbol = map.getStyle().layers?.find((l) => l.type === 'symbol')?.id;
        map.addLayer(
          {
            id: '3d-buildings',
            source: 'carto',
            'source-layer': 'building',
            type: 'fill-extrusion',
            minzoom: 11,
            // 3D 表示しない指定の建物は除外
            filter: ['!=', ['get', 'hide_3d'], true],
            paint: {
              // 高さに応じて色を変える（低層→暗い紺、高層→明るい青）
              'fill-extrusion-color': [
                'interpolate',
                ['linear'],
                ['coalesce', ['get', 'render_height'], 12],
                0, '#0e1626',
                25, '#1a2742',
                70, '#284568',
                160, '#3a608f',
              ],
              // ズームに応じてビルを立ち上げる
              'fill-extrusion-height': [
                'interpolate',
                ['linear'],
                ['zoom'],
                11, 0,
                13, ['coalesce', ['get', 'render_height'], 12],
              ],
              'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
              'fill-extrusion-opacity': 0.92,
            },
          },
          firstSymbol,
        );
        // 斜め上からの光で建物の面に陰影を付け、立体感を強める
        map.setLight({ anchor: 'viewport', color: '#dfeaff', intensity: 0.4, position: [1.5, 200, 35] });
        // 空（大気）で地平線に奥行きを出す（対応バージョンのみ）
        const skyMap = map as unknown as { setSky?: (s: Record<string, unknown>) => void };
        skyMap.setSky?.({
          'sky-color': '#0b1322',
          'sky-horizon-blend': 0.5,
          'horizon-color': '#16233c',
          'horizon-fog-blend': 0.6,
          'fog-color': '#080c16',
          'fog-ground-blend': 0.5,
        });
      } catch (err) {
        console.warn('3D ビルの追加に失敗しました:', err);
      }
    });

    mapRef.current = map;
    overlayRef.current = overlay;

    return () => {
      cancelAnimationFrame(frameRef.current);
      map.remove();
      mapRef.current = null;
      overlayRef.current = null;
    };
  }, []);

  // データが更新されたら静的レイヤ用データを作り直す
  useEffect(() => {
    staticRef.current = {
      paths: lines.map((line) => {
        // 環状線は終点を始点につないでループを閉じる
        const path =
          line.isLoop && line.path.length > 1 ? [...line.path, line.path[0]] : line.path;
        return { id: line.id, path, color: line.color };
      }),
      stations,
    };
  }, [lines, stations, version]);

  // フォーカス対象が変わったらカメラを該当路線へ移動し、強調表示を更新する
  useEffect(() => {
    focusRef.current = focusLineId ?? null;
    if (!focusLineId) {
      focusStationsRef.current = [];
      return;
    }
    const map = mapRef.current;
    const line = lines.find((l) => l.id === focusLineId);
    if (!line || line.path.length < 2) {
      focusStationsRef.current = [];
      return;
    }
    // 駅名ラベル用の駅集合：路線固有の駅リストがあれば優先、無ければ近接抽出で代替
    focusStationsRef.current =
      line.stations && line.stations.length > 0
        ? line.stations
        : stationsNearPath(line.path, stations);
    if (!map) return;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    for (const [lng, lat] of line.path) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
    map.fitBounds(
      [
        [minLng, minLat],
        [maxLng, maxLat],
      ],
      { padding: 90, duration: 1600, pitch: 45, maxZoom: 14 },
    );
  }, [focusLineId, lines, stations]);

  // 経路が変わったら経路全体にカメラをフィットする
  useEffect(() => {
    routeRef.current = route ?? null;
    const map = mapRef.current;
    if (!map || !route || route.segments.length === 0) return;
    let minLng = Infinity;
    let minLat = Infinity;
    let maxLng = -Infinity;
    let maxLat = -Infinity;
    const extend = (lng: number, lat: number) => {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    };
    for (const seg of route.segments) for (const [lng, lat] of seg.path) extend(lng, lat);
    for (const m of route.markers) extend(m.lng, m.lat);
    if (minLng <= maxLng) {
      map.fitBounds(
        [
          [minLng, minLat],
          [maxLng, maxLat],
        ],
        { padding: 100, duration: 1500, pitch: 45, maxZoom: 15 },
      );
    }
  }, [route]);

  // アニメーションループ（毎フレーム列車位置を更新して再描画）
  useEffect(() => {
    const animate = (time: number) => {
      const last = lastTimeRef.current || time;
      let dt = (time - last) / 1000;
      lastTimeRef.current = time;
      if (dt > MAX_DT_SEC) dt = MAX_DT_SEC;

      const trains = sim.tick(dt);
      const overlay = overlayRef.current;
      if (overlay) {
        const { paths, stations: stationData } = staticRef.current;
        const focus = focusRef.current;
        const route = routeRef.current;
        const routeActive = !!route && route.segments.length > 0;
        // 駅名ラベルは一定ズーム以上のときだけ出す（密集を防ぐ）
        const zoom = mapRef.current ? mapRef.current.getZoom() : 0;
        const showLabels = !!focus && !routeActive && zoom >= 11;
        // 経路ハイライトの脈動（発光）。ゆっくり呼吸するように。
        const pulse = 0.5 + 0.5 * Math.sin(time / 650);
        const pulseBucket = Math.round(pulse * 12);
        const dimKey = `${focus}-${routeActive}`;
        const routeSegments: RouteSegment[] = routeActive ? route!.segments : [];
        const routeMarkers: RouteMarker[] = routeActive ? route!.markers : [];
        overlay.setProps({
          layers: [
            // 路線（実線形）
            new PathLayer<PathDatum>({
              id: 'rails',
              data: paths,
              getPath: (d) => d.path,
              // 経路表示中は全体を減光、フォーカス時は対象を強調
              getColor: (d) => {
                if (routeActive) return [d.color[0], d.color[1], d.color[2], 22];
                if (!focus) return [d.color[0], d.color[1], d.color[2], 150];
                return d.id === focus
                  ? [d.color[0], d.color[1], d.color[2], 255]
                  : [d.color[0], d.color[1], d.color[2], 30];
              },
              getWidth: (d) => (!routeActive && focus && d.id === focus ? 6 : 3),
              widthMinPixels: 1,
              widthMaxPixels: 9,
              capRounded: true,
              jointRounded: true,
              updateTriggers: { getColor: dimKey, getWidth: dimKey },
            }),
            // 全駅
            new ScatterplotLayer<StationPoint>({
              id: 'stations',
              data: stationData,
              pickable: true,
              onClick: (info) => {
                if (info.object && onStationClickRef.current) {
                  onStationClickRef.current(info.object);
                  return true;
                }
                return false;
              },
              getPosition: (s) => [s.lng, s.lat],
              getRadius: 26,
              radiusMinPixels: 1.2,
              radiusMaxPixels: 4,
              getFillColor: focus || routeActive ? [180, 195, 215, 55] : [205, 220, 240, 150],
              updateTriggers: { getFillColor: dimKey },
            }),
            // 列車（線路方向に向く 3D 直方体）
            new SimpleMeshLayer<TrainState>({
              id: 'trains',
              data: trains,
              mesh: TRAIN_MESH,
              pickable: true,
              sizeScale: 1,
              parameters: { cullMode: 'none' },
              material: { ambient: 0.7, diffuse: 0.5, shininess: 40, specularColor: [90, 100, 120] },
              getPosition: (t) => [t.lng, t.lat],
              // 進行方位で向きを合わせる（[pitch, yaw, roll]、roll=Z軸回り=方位）
              getOrientation: (t) => [0, 0, -t.bearing],
              getScale: (t) => {
                const dimmed = routeActive || (focus && t.lineId !== focus);
                return [TRAIN_WID_M, TRAIN_LEN_M, dimmed ? TRAIN_HGT_M * 0.3 : TRAIN_HGT_M];
              },
              getColor: (t) => {
                const dimmed = routeActive || (focus && t.lineId !== focus);
                if (t.delaySec >= DELAY_THRESHOLD_SEC) return [255, 70, 70, dimmed ? 55 : 255];
                return [t.color[0], t.color[1], t.color[2], dimmed ? 50 : 255];
              },
              updateTriggers: { getScale: dimKey, getColor: dimKey },
            }),
            // フォーカス路線の駅（強調ドット）
            new ScatterplotLayer<StationPoint>({
              id: 'focus-stations',
              data: focus && !routeActive ? focusStationsRef.current : [],
              pickable: true,
              onClick: (info) => {
                if (info.object && onStationClickRef.current) {
                  onStationClickRef.current(info.object);
                  return true;
                }
                return false;
              },
              getPosition: (s) => [s.lng, s.lat],
              getRadius: 60,
              radiusMinPixels: 3,
              radiusMaxPixels: 7,
              stroked: true,
              getLineColor: [10, 14, 24, 220],
              lineWidthMinPixels: 1.5,
              getFillColor: [255, 255, 255, 240],
              updateTriggers: { data: dimKey },
            }),
            // フォーカス路線の駅名ラベル（一定ズーム以上で表示）
            new TextLayer<StationPoint>({
              id: 'station-labels',
              data: showLabels ? focusStationsRef.current : [],
              getPosition: (s) => [s.lng, s.lat],
              getText: (s) => s.name,
              getSize: 12,
              sizeUnits: 'pixels',
              getColor: [240, 247, 255, 255],
              getPixelOffset: [0, -11],
              getTextAnchor: 'middle',
              getAlignmentBaseline: 'bottom',
              fontFamily: LABEL_FONT,
              fontWeight: 700,
              characterSet: 'auto',
              background: true,
              getBackgroundColor: [6, 10, 18, 215],
              backgroundPadding: [5, 3, 5, 3],
              billboard: true,
              updateTriggers: { data: showLabels, getText: showLabels },
            }),
            // 経路ハイライト：外側のソフトハロー（depthTest無効で地表の路線とのチラつきを防ぐ）
            new PathLayer<RouteSegment>({
              id: 'route-halo',
              data: routeSegments,
              getPath: (d) => d.path,
              getColor: (d) => [d.color[0], d.color[1], d.color[2], Math.round(20 + pulse * 26)],
              getWidth: 16,
              widthUnits: 'pixels',
              capRounded: true,
              jointRounded: true,
              parameters: { depthCompare: 'always' },
              updateTriggers: { getColor: pulseBucket, getPath: routeActive },
            }),
            // 経路ハイライト：中間のグロー
            new PathLayer<RouteSegment>({
              id: 'route-glow',
              data: routeSegments,
              getPath: (d) => d.path,
              getColor: (d) => [d.color[0], d.color[1], d.color[2], Math.round(75 + pulse * 45)],
              getWidth: 8,
              widthUnits: 'pixels',
              capRounded: true,
              jointRounded: true,
              parameters: { depthCompare: 'always' },
              updateTriggers: { getColor: pulseBucket, getPath: routeActive },
            }),
            // 経路ハイライト：明るい芯
            new PathLayer<RouteSegment>({
              id: 'route-core',
              data: routeSegments,
              getPath: (d) => d.path,
              getColor: (d) => [
                Math.min(255, d.color[0] + 55),
                Math.min(255, d.color[1] + 55),
                Math.min(255, d.color[2] + 55),
                255,
              ],
              getWidth: 3,
              widthUnits: 'pixels',
              capRounded: true,
              jointRounded: true,
              parameters: { depthCompare: 'always' },
              updateTriggers: { getPath: routeActive },
            }),
            // 経路の出発・到着・乗換マーカー
            new ScatterplotLayer<RouteMarker>({
              id: 'route-markers',
              data: routeMarkers,
              getPosition: (m) => [m.lng, m.lat],
              getRadius: 90,
              radiusMinPixels: 6,
              radiusMaxPixels: 12,
              stroked: true,
              lineWidthMinPixels: 2,
              getLineColor: [10, 14, 24, 230],
              getFillColor: (m) =>
                m.kind === 'origin'
                  ? [70, 220, 140, 255]
                  : m.kind === 'dest'
                    ? [255, 90, 90, 255]
                    : [245, 245, 245, 255],
              parameters: { depthCompare: 'always' },
              updateTriggers: { data: routeActive },
            }),
            // 経路マーカーの駅名ラベル
            new TextLayer<RouteMarker>({
              id: 'route-marker-labels',
              data: routeMarkers,
              getPosition: (m) => [m.lng, m.lat],
              getText: (m) => m.name,
              getSize: 13,
              sizeUnits: 'pixels',
              getColor: [245, 250, 255, 255],
              getPixelOffset: [0, -14],
              getTextAnchor: 'middle',
              getAlignmentBaseline: 'bottom',
              fontFamily: LABEL_FONT,
              fontWeight: 700,
              characterSet: 'auto',
              background: true,
              getBackgroundColor: [6, 10, 18, 230],
              backgroundPadding: [6, 4, 6, 4],
              billboard: true,
              parameters: { depthCompare: 'always' },
              updateTriggers: { data: routeActive, getText: routeActive },
            }),
          ],
        });
      }
      frameRef.current = requestAnimationFrame(animate);
    };

    frameRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameRef.current);
  }, [sim]);

  return <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />;
}
