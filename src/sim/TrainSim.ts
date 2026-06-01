import type { LngLat, RailLine, TrainSeed, TrainState } from './types';
import { distanceMeters, lerpCoord } from './geo';

// 列車の内部状態
interface TrainEntity {
  id: string;
  lineId: string;
  segIndex: number; // 現在いる区間の開始点インデックス（path 上）
  progress: number; // 区間内の進捗（0〜1）
  direction: 1 | -1; // 進行方向
  speedMps: number; // 速度（m/s）
  label: string;
  delaySec: number;
}

// 遅延とみなす最小秒数（これ以上で赤く表示）
export const DELAY_THRESHOLD_SEC = 60;
// 区間距離の下限（メートル）。ゼロ割回避用。
const MIN_SEGMENT_M = 1;

// 列車を路線の実線形（path）に沿って進めるシミュレーションエンジン
export class TrainSim {
  private lines = new Map<string, RailLine>();
  private trains = new Map<string, TrainEntity>();

  // 路線を登録する
  setLines(lines: RailLine[]): void {
    this.lines.clear();
    for (const line of lines) {
      this.lines.set(line.id, line);
    }
  }

  trainCount(): number {
    return this.trains.size;
  }

  clearTrains(): void {
    this.trains.clear();
  }

  // 列車を直接追加する（静的モード用）
  addTrain(seed: TrainSeed): void {
    this.trains.set(seed.id, { ...seed });
  }

  // 実データから列車を追加・更新する。
  // 既存の列車は区間が変わったときだけ位置をリセットし、ポーリング間はなめらかに前進させる。
  upsertTrain(seed: Omit<TrainSeed, 'progress'>): void {
    const existing = this.trains.get(seed.id);
    if (existing) {
      if (existing.segIndex !== seed.segIndex || existing.direction !== seed.direction) {
        existing.segIndex = seed.segIndex;
        existing.direction = seed.direction;
        existing.progress = 0;
      }
      existing.speedMps = seed.speedMps;
      existing.label = seed.label;
      existing.delaySec = seed.delaySec;
    } else {
      this.trains.set(seed.id, { ...seed, progress: 0 });
    }
  }

  // 指定 ID 以外の列車を削除する（消えた列車の掃除）
  retainTrains(ids: Set<string>): void {
    for (const id of this.trains.keys()) {
      if (!ids.has(id)) {
        this.trains.delete(id);
      }
    }
  }

  // 現在の区間の開始インデックスと進行方向から、
  // 次の点インデックスと（折り返し後の）方向を求める
  private step(line: RailLine, segIndex: number, direction: 1 | -1): { from: number; dir: 1 | -1 } {
    const n = line.path.length;
    if (line.isLoop) {
      return { from: (segIndex + direction + n) % n, dir: direction };
    }
    const candidate = segIndex + direction;
    if (candidate >= 0 && candidate <= n - 1) {
      return { from: candidate, dir: direction };
    }
    // 端に到達したので折り返す
    const flipped: 1 | -1 = direction === 1 ? -1 : 1;
    return { from: segIndex + flipped, dir: flipped };
  }

  // dt 秒ぶん全列車を前進させ、現在の表示状態を返す
  tick(dtSeconds: number): TrainState[] {
    const states: TrainState[] = [];
    for (const train of this.trains.values()) {
      const line = this.lines.get(train.lineId);
      if (!line || line.path.length < 2) {
        continue;
      }

      let toStep = this.step(line, train.segIndex, train.direction);
      let from = line.path[train.segIndex];
      let to = line.path[toStep.from];
      let segLen = Math.max(distanceMeters(from, to), MIN_SEGMENT_M);

      train.progress += (train.speedMps * dtSeconds) / segLen;

      // 区間をまたいだら次の区間へ繰り越す（guard で無限ループを防止）
      let guard = 0;
      while (train.progress >= 1 && guard < line.path.length) {
        train.progress -= 1;
        train.segIndex = toStep.from;
        train.direction = toStep.dir;
        toStep = this.step(line, train.segIndex, train.direction);
        from = line.path[train.segIndex];
        to = line.path[toStep.from];
        segLen = Math.max(distanceMeters(from, to), MIN_SEGMENT_M);
        guard += 1;
      }

      const pos: LngLat = lerpCoord(from, to, train.progress);
      // 路線上の位置（0〜1）を点インデックスから求める
      const n = line.path.length;
      const posIndex = train.segIndex + train.progress;
      const rawFraction = line.isLoop ? posIndex / n : n > 1 ? posIndex / (n - 1) : 0;
      const lineFraction = Math.min(1, Math.max(0, rawFraction));
      states.push({
        id: train.id,
        lineId: line.id,
        lineName: line.name,
        color: line.color,
        lng: pos[0],
        lat: pos[1],
        label: train.label,
        delaySec: train.delaySec,
        lineFraction,
        direction: train.direction,
        speedMps: train.speedMps,
      });
    }
    return states;
  }
}
