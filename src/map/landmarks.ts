import type { Layer } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import {
  ConeGeometry,
  CubeGeometry,
  CylinderGeometry,
  SphereGeometry,
  TruncatedConeGeometry,
} from '@luma.gl/engine';

type Rgb = [number, number, number];

// パーツに使う基本形状（luma は y 軸が縦方向）
type GeomKind = 'cone4' | 'cone8' | 'cyl' | 'tcone' | 'sphere' | 'cube';

// ランドマークを構成する 1 パーツ（解決済みの配置情報を持つ）
interface Part {
  kind: GeomKind;
  dx: number; // 中心からの東西オフセット（m）
  dy: number; // 中心からの南北オフセット（m）
  centerM: number; // パーツ中心の地上高（m）
  scale: [number, number, number]; // mesh ローカルのスケール（x,z=横、y=縦）
  orient: [number, number, number]; // 向き [yaw(z), pitch(y), roll(x)]（度）
  color: Rgb;
}

// 縦に立つパーツ（塔・尖塔）。底面を bottomM に置く。
function vert(
  kind: GeomKind,
  color: Rgb,
  o: { bottomM: number; heightM: number; radiusM: number; dx?: number; dy?: number },
): Part {
  return {
    kind,
    color,
    dx: o.dx ?? 0,
    dy: o.dy ?? 0,
    centerM: o.bottomM + o.heightM / 2,
    scale: [o.radiusM, o.heightM, o.radiusM],
    orient: [0, 0, 90], // y 軸を地図の z 軸（上）へ
  };
}

// 横長の箱（駅舎・公共建物）。wM=幅(東西)、dM=奥行(南北)。
function box(
  color: Rgb,
  o: { bottomM: number; heightM: number; wM: number; dM: number; dx?: number; dy?: number },
): Part {
  return {
    kind: 'cube',
    color,
    dx: o.dx ?? 0,
    dy: o.dy ?? 0,
    centerM: o.bottomM + o.heightM / 2,
    scale: [o.wM, o.heightM, o.dM],
    orient: [0, 0, 90],
  };
}

// 縦の輪（観覧車）。薄い円盤を水平軸にして垂直に立てる。
function wheel(color: Rgb, o: { centerM: number; radiusM: number; thickM: number }): Part {
  return {
    kind: 'cyl',
    color,
    dx: 0,
    dy: 0,
    centerM: o.centerM,
    scale: [o.radiusM, o.thickM, o.radiusM],
    orient: [90, 0, 0], // y 軸を地図の x 軸（水平）へ → 円盤面が縦
  };
}

// 球（フジテレビ・ドーム）
function ball(color: Rgb, o: { centerM: number; radiusM: number; dx?: number; dy?: number }): Part {
  return {
    kind: 'sphere',
    color,
    dx: o.dx ?? 0,
    dy: o.dy ?? 0,
    centerM: o.centerM,
    scale: [o.radiusM, o.radiusM, o.radiusM],
    orient: [0, 0, 0],
  };
}

interface Landmark {
  name: string;
  lng: number;
  lat: number;
  parts: Part[];
}

// 主要ランドマーク（実座標・概算寸法）。象徴形状をパーツで組み立てる。
export const LANDMARKS: Landmark[] = [
  {
    name: '東京スカイツリー',
    lng: 139.8107,
    lat: 35.7101,
    parts: [
      vert('tcone', [206, 216, 236], { bottomM: 0, heightM: 497, radiusM: 30 }), // 先細りの塔
      vert('cyl', [226, 233, 246], { bottomM: 340, heightM: 20, radiusM: 23 }), // 展望デッキ(350)
      vert('cyl', [226, 233, 246], { bottomM: 438, heightM: 14, radiusM: 16 }), // 展望回廊(450)
      vert('cyl', [206, 216, 236], { bottomM: 497, heightM: 137, radiusM: 3.5 }), // ゲイン塔
    ],
  },
  {
    
    name: '東京駅',
    lng: 139.7671,
    lat: 35.6812,
    parts: [
      box([150, 86, 64], { bottomM: 0, heightM: 28, wM: 110, dM: 30 }), // 丸の内駅舎（赤レンガ）
      ball([122, 72, 56], { centerM: 36, radiusM: 11, dx: -40 }), // 南ドーム
      ball([122, 72, 56], { centerM: 36, radiusM: 11, dx: 40 }), // 北ドーム
    ],
  },
];

// type ごとの単位ジオメトリ（半径1・高さ1、中心が原点）
const UNIT: Record<GeomKind, ConeGeometry | CylinderGeometry | SphereGeometry | CubeGeometry> = {
  cone4: new ConeGeometry({ nradial: 4 }),
  cone8: new ConeGeometry({ nradial: 8 }),
  cyl: new CylinderGeometry({ nradial: 20 }),
  tcone: new TruncatedConeGeometry({ topRadius: 0.32, bottomRadius: 1, nradial: 20 }),
  sphere: new SphereGeometry({ nlat: 18, nlong: 28 }),
  cube: new CubeGeometry(),
};

// 描画用にパーツへ展開した型（ランドマークの座標を含む）
interface FlatPart extends Part {
  lng: number;
  lat: number;
}

// ランドマークの SimpleMeshLayer 群を返す（基本形状ごとに 1 レイヤー）
export function landmarkLayers(): Layer[] {
  const flat: FlatPart[] = [];
  for (const lm of LANDMARKS) {
    for (const p of lm.parts) flat.push({ ...p, lng: lm.lng, lat: lm.lat });
  }
  const kinds = [...new Set(flat.map((f) => f.kind))];
  return kinds.map(
    (kind) =>
      new SimpleMeshLayer<FlatPart>({
        id: `landmark-${kind}`,
        data: flat.filter((f) => f.kind === kind),
        mesh: UNIT[kind],
        getPosition: (f) => [f.lng, f.lat],
        getTranslation: (f) => [f.dx, f.dy, f.centerM],
        getScale: (f) => f.scale,
        getOrientation: (f) => f.orient,
        getColor: (f) => [f.color[0], f.color[1], f.color[2], 255],
        pickable: false,
      }),
  );
}
