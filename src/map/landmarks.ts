import type { Layer } from '@deck.gl/core';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { ConeGeometry, CubeGeometry, CylinderGeometry, SphereGeometry } from '@luma.gl/engine';

// ランドマークの種類（象徴的な簡略形状を選ぶためのキー）
export type LandmarkType = 'tower' | 'skytree' | 'box' | 'sphere' | 'ferris' | 'castle';

export interface Landmark {
  name: string;
  lng: number;
  lat: number;
  type: LandmarkType;
  heightM: number; // 塔・箱は高さ、球・観覧車は中心の高さ
  radiusM: number; // 底面の半径（おおよそ）
  color: [number, number, number];
}

// 主要ランドマーク（実座標・概算寸法）。写実モデルが用意できないため象徴形状で表示する。
export const LANDMARKS: Landmark[] = [
  { name: '東京タワー', lng: 139.7454, lat: 35.6586, type: 'tower', heightM: 333, radiusM: 24, color: [236, 92, 58] },
  { name: '東京スカイツリー', lng: 139.8107, lat: 35.7101, type: 'skytree', heightM: 634, radiusM: 17, color: [206, 216, 236] },
  { name: '東京都庁', lng: 139.6917, lat: 35.6896, type: 'box', heightM: 243, radiusM: 28, color: [112, 124, 150] },
  { name: '国会議事堂', lng: 139.7449, lat: 35.676, type: 'box', heightM: 65, radiusM: 46, color: [168, 164, 150] },
  { name: '東京駅', lng: 139.7671, lat: 35.6812, type: 'box', heightM: 31, radiusM: 58, color: [150, 86, 64] },
  { name: 'フジテレビ', lng: 139.7935, lat: 35.6267, type: 'sphere', heightM: 90, radiusM: 16, color: [186, 196, 208] },
  { name: '葛西臨海公園 大観覧車', lng: 139.8607, lat: 35.6404, type: 'ferris', heightM: 117, radiusM: 55, color: [108, 198, 230] },
  { name: 'シンデレラ城', lng: 139.8805, lat: 35.6329, type: 'castle', heightM: 51, radiusM: 22, color: [216, 222, 238] },
];

// type ごとの単位ジオメトリ（半径1・高さ1、中心が原点。luma は y 軸が縦方向）
const GEOMETRY: Record<LandmarkType, ConeGeometry | CylinderGeometry | SphereGeometry | CubeGeometry> = {
  tower: new ConeGeometry({ nradial: 4 }), // 四角錐（東京タワー）
  skytree: new CylinderGeometry({ nradial: 12 }), // 細い塔
  box: new CubeGeometry(), // 箱（駅舎・公共建物）
  sphere: new SphereGeometry({ nlat: 16, nlong: 24 }), // 球（フジテレビ）
  ferris: new CylinderGeometry({ nradial: 24 }), // 円盤（観覧車）
  castle: new ConeGeometry({ nradial: 8 }), // 尖塔（城の象徴）
};

// 縦に立てる回転（luma の y 軸を地図の z 軸へ）。球・観覧車はそのまま。
function orientationOf(d: Landmark): [number, number, number] {
  if (d.type === 'sphere' || d.type === 'ferris') return [0, 0, 0];
  return [0, 0, 90];
}

// メートル換算のスケール（mesh ローカル：x,z=半径、y=高さ）
function scaleOf(d: Landmark): [number, number, number] {
  if (d.type === 'sphere') return [d.radiusM, d.radiusM, d.radiusM];
  if (d.type === 'ferris') return [d.radiusM, d.radiusM * 0.1, d.radiusM]; // 薄い円盤
  return [d.radiusM, d.heightM, d.radiusM];
}

// 地面に接地させる高さオフセット（中心原点のぶんを持ち上げる）
function translationOf(d: Landmark): [number, number, number] {
  if (d.type === 'sphere') return [0, 0, d.heightM];
  if (d.type === 'ferris') return [0, 0, d.radiusM];
  return [0, 0, d.heightM / 2];
}

// ランドマークの SimpleMeshLayer 群を返す（type ごとに 1 レイヤー）
export function landmarkLayers(): Layer[] {
  const types = [...new Set(LANDMARKS.map((l) => l.type))];
  return types.map(
    (type) =>
      new SimpleMeshLayer<Landmark>({
        id: `landmark-${type}`,
        data: LANDMARKS.filter((l) => l.type === type),
        mesh: GEOMETRY[type],
        getPosition: (d) => [d.lng, d.lat],
        getColor: (d) => [d.color[0], d.color[1], d.color[2], 255],
        getOrientation: (d) => orientationOf(d),
        getScale: (d) => scaleOf(d),
        getTranslation: (d) => translationOf(d),
        pickable: false,
      }),
  );
}
