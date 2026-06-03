// OpenStreetMap（Overpass API）から首都圏4都県の鉄道データを取得し、
// アプリ用の静的データ src/data/osmNetwork.json を生成するスクリプト。
//
// 取得内容:
//   - 全駅（railway=station / halt）の座標・名称
//   - 路線（route=train/subway/monorail/light_rail リレーション）の実線形と名称・色
//
// 実行: node scripts/fetchOsmNetwork.mjs
import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Overpass API エンドポイント
const ENDPOINT = 'https://overpass-api.de/api/interpreter';
// 対象範囲（千葉・埼玉・東京・神奈川を含む bbox）: south,west,north,east
const BBOX = '34.85,138.90,36.30,140.90';
// bbox 外をクリップする際の余白（度）
const MARGIN = 0.06;
const CLIP = {
  south: 34.85 - MARGIN,
  west: 138.9 - MARGIN,
  north: 36.3 + MARGIN,
  east: 140.9 + MARGIN,
};
const UA = 'tokyo-train-twin/0.1 (digital-twin research; contact: local)';
// 連続点間がこの距離（メートル）を超えたら経路の断絶（直線チャート）とみなして分割する
const MAX_VERTEX_GAP_M = 2500;
// 取得する路線種別
const ROUTE_TYPES = ['train', 'subway', 'monorail', 'light_rail'];
// クエリ間の待機（Overpass への配慮）
const QUERY_DELAY_MS = 4000;
// 1 クエリのタイムアウト（ミリ秒）
const FETCH_TIMEOUT_MS = 300000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 座標を 5 桁に丸める（約 1m 精度）
const round = (x) => Math.round(x * 1e5) / 1e5;
// 度の二乗距離（連結時の近接判定用）
const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
// 2 点間の距離（メートル、平面近似）
const distMeters = (lng1, lat1, lng2, lat2) => {
  const R = 6378137;
  const D = Math.PI / 180;
  const m = ((lat1 + lat2) / 2) * D;
  const dx = (lng2 - lng1) * D * Math.cos(m) * R;
  const dy = (lat2 - lat1) * D * R;
  return Math.hypot(dx, dy);
};

// ポリゴンが囲む面積（平方メートル、平面近似）。
// 環状線と「往復線」を区別するために使う（往復は面積がほぼ 0）。
const polygonAreaM2 = (path) => {
  if (path.length < 3) return 0;
  const R = 6378137;
  const D = Math.PI / 180;
  let lat0 = 0;
  for (const p of path) lat0 += p[1];
  lat0 /= path.length;
  const k = Math.cos(lat0 * D);
  let area = 0;
  for (let i = 0; i < path.length; i++) {
    const a = path[i];
    const b = path[(i + 1) % path.length];
    const ax = a[0] * D * R * k;
    const ay = a[1] * D * R;
    const bx = b[0] * D * R * k;
    const by = b[1] * D * R;
    area += ax * by - bx * ay;
  }
  return Math.abs(area) / 2;
};
// 環状線とみなす最小の囲み面積（平方メートル）。往復線（面積≒0）を除外する。
const LOOP_MIN_AREA_M2 = 8_000_000; // 8 km²

// Overpass にクエリを投げて JSON を返す
// （この環境では Node の fetch が直結できないため curl 経由で取得する）
// Overpass は混雑時に XML/HTML のエラーを返すため、リトライで吸収する。
let queryCounter = 0;
async function overpass(query, label = '') {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const tmp = join(tmpdir(), `overpass-query-${process.pid}-${queryCounter++}.txt`);
    writeFileSync(tmp, query);
    let stdout = '';
    try {
      stdout = execFileSync(
        'curl',
        [
          '-s',
          '--max-time',
          String(Math.round(FETCH_TIMEOUT_MS / 1000)),
          '-A',
          UA,
          '-H',
          'Accept: application/json',
          '--data-urlencode',
          `data@${tmp}`,
          ENDPOINT,
        ],
        { maxBuffer: 512 * 1024 * 1024 },
      ).toString('utf8');
    } catch (err) {
      lastErr = err;
      console.error(`  [${label}] 試行${attempt}: curl 失敗、待機して再試行…`);
      await sleep(attempt * 8000);
      continue;
    }
    if (stdout.trimStart().startsWith('{')) {
      try {
        return JSON.parse(stdout);
      } catch (err) {
        lastErr = err;
      }
    } else {
      lastErr = new Error('非JSON応答: ' + stdout.trim().slice(0, 160));
    }
    console.error(`  [${label}] 試行${attempt}: ${lastErr.message.slice(0, 80)} — 待機して再試行…`);
    await sleep(attempt * 8000);
  }
  throw lastErr;
}

// 点が（余白込み）bbox 内か
function inClip(lng, lat) {
  return lng >= CLIP.west && lng <= CLIP.east && lat >= CLIP.south && lat <= CLIP.north;
}

// way 同士を連結とみなす端点間の最大距離（メートル）
const TOUCH_M = 30;
// 2 点が連結点とみなせるか
function endpointsTouch(a, b) {
  return distMeters(a[0], a[1], b[0], b[1]) < TOUCH_M;
}

// リレーションの停車駅メンバー（role が stop で始まる node）の座標
function stopCoords(rel) {
  return rel.members
    .filter((m) => m.type === 'node' && m.lat != null && (m.role || '').startsWith('stop'))
    .map((m) => [m.lon, m.lat]);
}

// 連結成分（path）が、何個の停車駅を 200m 以内に含むか
function stopCoverage(path, stops) {
  let cover = 0;
  for (const sp of stops) {
    let nd = Infinity;
    for (const p of path) {
      const dd = distMeters(sp[0], sp[1], p[0], p[1]);
      if (dd < nd) {
        nd = dd;
        if (nd < 200) break;
      }
    }
    if (nd < 200) cover++;
  }
  return cover;
}

// リレーションの way メンバを「端点の一致」で連結し、すべての連結成分（ポリライン群）を返す。
function buildComponents(rel) {
  const ways = rel.members
    .filter((m) => m.type === 'way' && Array.isArray(m.geometry) && m.geometry.length >= 2)
    .map((m) => m.geometry.map((g) => [g.lon, g.lat]));
  if (!ways.length) {
    const nodes = rel.members.filter((m) => m.type === 'node' && m.lat != null).map((n) => [n.lon, n.lat]);
    return nodes.length >= 2 ? [nodes] : [];
  }

  const used = new Array(ways.length).fill(false);
  const components = [];
  for (let seed = 0; seed < ways.length; seed++) {
    if (used[seed]) continue;
    let path = ways[seed].slice();
    used[seed] = true;

    // 前方へ伸ばす
    let extended = true;
    while (extended) {
      extended = false;
      const end = path[path.length - 1];
      for (let i = 0; i < ways.length; i++) {
        if (used[i]) continue;
        const w = ways[i];
        if (endpointsTouch(end, w[0])) {
          for (let k = 1; k < w.length; k++) path.push(w[k]);
          used[i] = true;
          extended = true;
          break;
        }
        if (endpointsTouch(end, w[w.length - 1])) {
          for (let k = w.length - 2; k >= 0; k--) path.push(w[k]);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }

    // 後方へ伸ばす
    extended = true;
    while (extended) {
      extended = false;
      const start = path[0];
      for (let i = 0; i < ways.length; i++) {
        if (used[i]) continue;
        const w = ways[i];
        if (endpointsTouch(start, w[w.length - 1])) {
          for (let k = w.length - 2; k >= 0; k--) path.unshift(w[k]);
          used[i] = true;
          extended = true;
          break;
        }
        if (endpointsTouch(start, w[0])) {
          for (let k = 1; k < w.length; k++) path.unshift(w[k]);
          used[i] = true;
          extended = true;
          break;
        }
      }
    }

    components.push(path);
  }
  return components;
}

// 駅が成分（path）に整合しているとみなす最大距離（メートル）
const ALIGN_M = 300;

// 成分上で座標に最も近い点のインデックスと距離
function nearestOnComp(comp, lng, lat) {
  let best = Infinity;
  let bi = 0;
  for (let i = 0; i < comp.length; i++) {
    const dpt = distMeters(lng, lat, comp[i][0], comp[i][1]);
    if (dpt < best) {
      best = dpt;
      bi = i;
    }
  }
  return { bi, best };
}

// 1 つの成分上で駅 A→B を結ぶ線路区間を返す（整合し、遠回りでないときのみ）
function trackBetween(comp, A, B) {
  const na = nearestOnComp(comp, A.lng, A.lat);
  const nb = nearestOnComp(comp, B.lng, B.lat);
  if (na.best >= ALIGN_M || nb.best >= ALIGN_M || na.bi === nb.bi) return null;
  const lo = Math.min(na.bi, nb.bi);
  const hi = Math.max(na.bi, nb.bi);
  let trackLen = 0;
  for (let k = lo; k < hi; k++) trackLen += distMeters(comp[k][0], comp[k][1], comp[k + 1][0], comp[k + 1][1]);
  const straight = distMeters(A.lng, A.lat, B.lng, B.lat);
  if (trackLen > straight * 2.5 + 300) return null;
  let seg = comp.slice(lo, hi + 1);
  if (na.bi > nb.bi) seg = seg.reverse();
  return { seg, score: na.best + nb.best };
}

// 全成分から駅 A→B の最良の線路区間を返す（無ければ直線）
function reconstructBetween(components, A, B) {
  let best = null;
  for (const comp of components) {
    const r = trackBetween(comp, A, B);
    if (r && (!best || r.score < best.score)) best = r;
  }
  return best ? best.seg : [[A.lng, A.lat], [B.lng, B.lat]];
}

// 連結成分（実線形）への射影点の弧長（m）と距離（m）を返す。
// 駅を線形に沿った順序に並べ替えるために使う。
function projectArc(comp, lng, lat) {
  let best = Infinity;
  let bestArc = 0;
  let bestPoint = comp[0];
  let arc = 0;
  const kx = Math.cos(lat * (Math.PI / 180)); // 経度方向の緯度補正
  for (let i = 0; i + 1 < comp.length; i++) {
    const ax = comp[i][0] * kx;
    const ay = comp[i][1];
    const bx = comp[i + 1][0] * kx;
    const by = comp[i + 1][1];
    const px = lng * kx;
    const py = lat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const ex = px - (ax + dx * t);
    const ey = py - (ay + dy * t);
    const d2 = ex * ex + ey * ey;
    const segLen = distMeters(comp[i][0], comp[i][1], comp[i + 1][0], comp[i + 1][1]);
    if (d2 < best) {
      best = d2;
      bestArc = arc + segLen * t;
      bestPoint = [
        comp[i][0] + (comp[i + 1][0] - comp[i][0]) * t,
        comp[i][1] + (comp[i + 1][1] - comp[i][1]) * t,
      ];
    }
    arc += segLen;
  }
  return { arc: bestArc, dist: distMeters(lng, lat, bestPoint[0], bestPoint[1]) };
}

// 隣接した同名駅をまとめる
function dedupAdjacentStations(arr) {
  const out = [];
  for (const s of arr) {
    if (!out.length || out[out.length - 1].name !== s.name) out.push(s);
  }
  return out;
}

// 停車駅を「実線形（最も多くの駅を通る連結成分）」に沿った順に並べ替える。
// OSM のメンバー順は方向・系統が混在して乱れることがあるため、線形へ射影して正す。
function orderStationsAlongTrack(stations, components) {
  if (components.length === 0 || stations.length < 3) return stations;
  // 各成分が 200m 以内に通る駅数を数え、最も多い成分を主線とする
  const projByComp = components.map((comp) => stations.map((s) => projectArc(comp, s.lng, s.lat)));
  let mainIdx = 0;
  let mainCover = -1;
  components.forEach((_, c) => {
    const cover = projByComp[c].filter((r) => r.dist < 200).length;
    if (cover > mainCover) {
      mainCover = cover;
      mainIdx = c;
    }
  });
  const projMain = projByComp[mainIdx];
  // 主線に整合する駅（300m 以内）は弧長順、それ以外は元の順序のまま末尾に残す
  const aligned = [];
  const rest = [];
  stations.forEach((s, i) => {
    if (projMain[i].dist < 300) aligned.push({ s, arc: projMain[i].arc });
    else rest.push(s);
  });
  if (aligned.length < 2) return stations; // 並べ替えに足る整合駅がない
  aligned.sort((a, b) => a.arc - b.arc);
  const sorted = [...aligned.map((x) => x.s), ...rest];
  // 隣接駅間の距離合計（駅順の自然さ）が明確に短くなるときだけ採用する。
  // 元から正しい順序の路線（地下鉄など）を、貧弱な線形への射影で却って乱さないための保険。
  const chainLen = (arr) => {
    let s = 0;
    for (let i = 0; i + 1 < arr.length; i++) {
      s += distMeters(arr[i].lng, arr[i].lat, arr[i + 1].lng, arr[i + 1].lat);
    }
    return s;
  };
  return chainLen(sorted) < chainLen(stations) * 0.98 ? sorted : stations;
}

// 駅の並び順に沿って、隣接駅間を線路（または直線）でつなぎ、全駅をカバーする path を再構築する
function reconstructPath(components, stations) {
  const path = [];
  const push = (p) => {
    const last = path[path.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) path.push(p);
  };
  for (let i = 0; i + 1 < stations.length; i++) {
    const seg = reconstructBetween(components, stations[i], stations[i + 1]);
    for (const p of seg) push(p);
  }
  return path;
}

// 橋渡し（駅間に線路が無い直線）の許容上限（メートル）。これを超える隙間で分割する。
const BRIDGE_MAX_M = 5000;

// クリップ＋丸め＋連続重複除去のうえ、長すぎる橋渡し（巨大チャート）で分割し最長区間を残す。
// 都市部の短い橋渡し（隣接駅間）は保持される。
function clipDedup(path) {
  const out = [];
  for (const p of path) {
    if (!inClip(p[0], p[1])) continue;
    const q = [round(p[0]), round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  return longestContiguousRun(out, BRIDGE_MAX_M);
}

// 連続点間の大きなギャップで分割し、最も長い連続区間だけを返す。
// （bbox クリップや経路順の乱れで生じる「直線チャート」を除去する）
function longestContiguousRun(pts, maxGap) {
  if (pts.length < 2) return pts;
  let best = [pts[0]];
  let cur = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const g = distMeters(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (g > maxGap) {
      if (cur.length > best.length) best = cur;
      cur = [pts[i]];
    } else {
      cur.push(pts[i]);
    }
  }
  if (cur.length > best.length) best = cur;
  return best;
}

// パスを bbox 内にクリップし、丸め・連続重複除去のうえ、最長連続区間を採用する
function cleanPath(path) {
  const out = [];
  for (const p of path) {
    if (!inClip(p[0], p[1])) continue;
    const q = [round(p[0]), round(p[1])];
    const last = out[out.length - 1];
    if (!last || last[0] !== q[0] || last[1] !== q[1]) out.push(q);
  }
  // 断絶（直線チャート）を除くため、最長の連続区間だけを残す
  return longestContiguousRun(out, MAX_VERTEX_GAP_M);
}

// 路線名から方向・種別の末尾装飾を除いて集約キーを作る
function baseName(tags) {
  const raw = tags.name || tags.ref || '';
  return raw
    .replace(/\s*[（(][^（()）]*[)）]\s*$/g, '') // 末尾の括弧書き（方面など）
    .replace(/\s*(上り|下り|内回り|外回り)\s*$/g, '')
    .trim();
}

// #RRGGBB を [r,g,b] に。無効なら null。
function parseColour(hex) {
  if (!hex) return null;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// 色が無い路線に割り当てるパレット
const PALETTE = [
  [0, 178, 229], [241, 90, 34], [255, 212, 0], [0, 150, 80], [221, 0, 123],
  [143, 118, 214], [0, 160, 140], [232, 82, 152], [0, 121, 194], [108, 187, 90],
  [247, 130, 30], [0, 82, 159], [199, 42, 48], [0, 158, 150], [156, 94, 49],
];

async function main() {
  // 1) 全駅を取得
  console.error('駅を取得中…');
  const stationsJson = await overpass(
    `[out:json][timeout:300];
( node["railway"="station"](${BBOX}); node["railway"="halt"](${BBOX}); );
out body;`,
    'stations',
  );
  const seenStation = new Set();
  const stations = [];
  for (const e of stationsJson.elements) {
    if (e.type !== 'node' || e.lat == null) continue;
    const name = e.tags?.['name:ja'] || e.tags?.name;
    if (!name) continue;
    const key = `${round(e.lon)},${round(e.lat)}`;
    if (seenStation.has(key)) continue;
    seenStation.add(key);
    stations.push({ name, lng: round(e.lon), lat: round(e.lat) });
  }
  console.error('  駅数:', stations.length);
  await sleep(QUERY_DELAY_MS);

  // 駅の格子インデックス（停車駅メンバー → 駅名の最近傍照合用）
  const GRID = 0.01; // 約 1km
  const grid = new Map();
  const cellKey = (lng, lat) => `${Math.floor(lng / GRID)},${Math.floor(lat / GRID)}`;
  for (const s of stations) {
    const k = cellKey(s.lng, s.lat);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(s);
  }
  // 指定座標に最も近い駅（300m 以内）を返す
  const nearestStation = (lng, lat) => {
    const cx = Math.floor(lng / GRID);
    const cy = Math.floor(lat / GRID);
    let best = null;
    let bestD = 300;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const cell = grid.get(`${cx + dx},${cy + dy}`);
        if (!cell) continue;
        for (const s of cell) {
          const dist = distMeters(lng, lat, s.lng, s.lat);
          if (dist < bestD) {
            bestD = dist;
            best = s;
          }
        }
      }
    }
    return best;
  };

  // リレーションの停車駅メンバー（role が stop で始まる node）から路線の駅リストを作る
  const buildLineStations = (rel) => {
    const out = [];
    let lastName = '';
    for (const m of rel.members) {
      if (m.type !== 'node' || m.lat == null) continue;
      if (!(m.role || '').startsWith('stop')) continue;
      const st = nearestStation(m.lon, m.lat);
      if (!st || st.name === lastName) continue;
      out.push({ name: st.name, lng: st.lng, lat: st.lat });
      lastName = st.name;
    }
    return out;
  };

  // 2) 路線リレーションを種別ごとに取得
  const rawRelations = [];
  for (const rt of ROUTE_TYPES) {
    console.error(`路線リレーション(${rt})を取得中…`);
    const j = await overpass(
      `[out:json][timeout:600];
relation["route"="${rt}"](${BBOX});
out geom;`,
      rt,
    );
    const rels = j.elements.filter((e) => e.type === 'relation' && Array.isArray(e.members));
    console.error(`  ${rt}: ${rels.length} 件`);
    rawRelations.push(...rels);
    await sleep(QUERY_DELAY_MS);
  }

  // 3) リレーション → 路線（実線形）へ整形し、名称で集約（最長パスを採用）
  const byName = new Map();
  for (const rel of rawRelations) {
    const tags = rel.tags || {};
    const name = baseName(tags);
    if (!name) continue;
    const components = buildComponents(rel);
    // 停車駅を取得し、実線形に沿った順序へ整える（OSM のメンバー順の乱れを補正）
    const lineStations = dedupAdjacentStations(
      orderStationsAlongTrack(buildLineStations(rel), components),
    );

    // 駅順に沿って全駅をカバーする path を再構築する（駅情報が無ければ最長成分）
    let raw;
    if (lineStations.length >= 2) {
      raw = reconstructPath(components, lineStations);
    } else {
      raw = components.slice().sort((a, b) => b.length - a.length)[0] || [];
    }
    if (raw.length < 2) continue;

    // 環状判定：始終点駅が近接し十分な面積を囲むなら、閉合区間を足して環状にする
    let isLoop = false;
    if (lineStations.length > 3) {
      const f = lineStations[0];
      const l = lineStations[lineStations.length - 1];
      const span = distMeters(f.lng, f.lat, l.lng, l.lat);
      if (span < 3000 && polygonAreaM2(raw) > LOOP_MIN_AREA_M2) {
        const closing = reconstructBetween(components, l, f);
        for (const p of closing) raw.push(p);
        isLoop = true;
      }
    }

    const path = clipDedup(raw);
    if (path.length < 2) continue;
    const line = {
      id: `osm-${rel.id}`,
      name,
      color: parseColour(tags.colour),
      isLoop,
      path,
      stations: lineStations,
    };
    const prev = byName.get(name);
    // 駅数がより多い（≒より完全な）変種を採用
    if (!prev || (line.stations?.length ?? 0) > (prev.stations?.length ?? 0)) byName.set(name, line);
  }

  // 4) パレットで色を補完
  const lines = [...byName.values()].sort((a, b) => b.path.length - a.path.length);
  let pi = 0;
  for (const line of lines) {
    if (!line.color) {
      line.color = PALETTE[pi % PALETTE.length];
      pi++;
    }
  }
  console.error('  路線数(集約後):', lines.length);

  // 5) 出力
  const out = { bbox: BBOX, generatedAt: process.env.GEN_AT || '', stations, lines };
  const json = JSON.stringify(out);
  writeFileSync(new URL('../public/osmNetwork.json', import.meta.url), json);
  console.error('書き出し: public/osmNetwork.json');
  console.error(`  サイズ: ${(json.length / 1024 / 1024).toFixed(2)} MB / 駅 ${stations.length} / 路線 ${lines.length}`);
}

main().catch((err) => {
  console.error('失敗:', err);
  process.exit(1);
});
