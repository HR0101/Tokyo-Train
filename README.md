# 東京鉄道デジタルツイン

首都圏（千葉・埼玉・東京・神奈川）の鉄道網を 3D ダークマップ上に再現するデジタルツイン
Web アプリです。実際の全駅と実路線形を表示し、ミニチュアの列車ブロックが線路上を
リアルタイムに移動します。

## 特徴

- **3D ダークマップ**: MapLibre GL JS（CARTO 無料ダークスタイル）+ deck.gl
- **全駅・実路線形（OSM）**: OpenStreetMap 由来の **全 1961 駅・270 路線** を実座標で表示
  （トークン不要で動作する STATIC モード）
- **リアルタイム列車（ODPT）**: トークン設定時は ODPT の列車現在位置・遅延を 15 秒ごとに取得
- **位置補間エンジン**: 路線の実線形（ポリライン）に沿って列車をなめらかに走らせる
- **遅延の可視化**: 60 秒以上遅れている編成は赤色で強調

## セットアップ

```bash
npm install
npm run dev
```

ブラウザで http://localhost:5173 が開きます。トークン未設定でも OSM の全駅・路線が表示
されます（`public/osmNetwork.json` を読み込みます）。

### OSM データの再生成

全駅・路線データは Overpass API（OpenStreetMap）から取得して `public/osmNetwork.json`
に保存しています。範囲や内容を変えたい場合は再生成します。

```bash
node scripts/fetchOsmNetwork.mjs
```

対象範囲（bbox）や取得する路線種別はスクリプト冒頭の定数で調整できます。

## 実データ（ODPT）を使う

ODPT のアクセストークンを設定すると、実際の走行列車・遅延を表示する LIVE モードになります。

1. https://developer.odpt.org/ で無料アカウントを登録
2. 「アクセストークンの確認・追加」からトークンを発行
3. `.env.example` を `.env` にコピーし、トークンを設定

```bash
cp .env.example .env
# VITE_ODPT_TOKEN=ここに発行したトークン
```

4. `npm run dev` を再起動すると LIVE モードになります（`src/odpt/client.ts` の
   `LIVE_RAILWAYS` で対象路線を管理）

> `.env` は `.gitignore` 済みです。トークンは Git にコミットされません。

## 構成

```
scripts/
└ fetchOsmNetwork.mjs   OSMから全駅・路線を取得し public/osmNetwork.json を生成
public/
└ osmNetwork.json       生成済みデータ（全駅＋実路線形、実行時に fetch）
src/
├ main.tsx              エントリーポイント
├ App.tsx               モード切替（LIVE / STATIC）とポーリング
├ index.css             ダークテーマ・HUD スタイル
├ odpt/
│  ├ client.ts          ODPT API クライアント・対象路線の定義
│  └ types.ts           ODPT レスポンス型
├ sim/
│  ├ TrainSim.ts        列車を実線形に沿って進める位置補間シミュレーション
│  ├ network.ts         OSM静的 / ODPT実データ からネットワークを構築
│  ├ geo.ts             距離・補間・全長の計算
│  └ types.ts           内部型
├ map/
│  └ TrainMap.tsx       MapLibre + deck.gl の 3D マップ（路線・全駅・列車）
└ components/
   └ Hud.tsx            ダッシュボード（編成数・路線数・駅数）
```

## データ出典

- OpenStreetMap contributors（ODbL） https://www.openstreetmap.org/
- 公共交通オープンデータセンター（ODPT、LIVE モード時） https://www.odpt.org/
