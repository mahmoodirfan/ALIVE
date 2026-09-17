import type { Millis, Simulation } from '@alive-internal/core';
import { HERO_HORIZON, MINUTE } from '../scenario/constants.js';
import type { LaunchWorld } from '../scenario/types.js';

export type PlaybackSpeed = 1 | 2 | 5;
export interface PlaybackSnapshot { playing: boolean; speed: PlaybackSpeed; }

type Listener = () => void;

export class PlaybackController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private playing = false;
  private speed: PlaybackSpeed = 1;
  private snapshot: PlaybackSnapshot = Object.freeze({ playing: false, speed: 1 });
  private readonly listeners = new Set<Listener>();

  constructor(private readonly simulation: Simulation<LaunchWorld>) {}

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PlaybackSnapshot => this.snapshot;

  setSpeed(speed: PlaybackSpeed): void {
    this.speed = speed;
    this.emit();
  }

  play(): void {
    if (this.playing || this.simulation.getViewMode() === 'scrubbing') return;
    this.playing = true;
    this.emit();
    this.timer = setInterval(() => this.tick(), 180);
  }

  pause(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    if (!this.playing) return;
    this.playing = false;
    this.emit();
  }

  step(): void {
    this.pause();
    if (this.simulation.getViewMode() === 'scrubbing') return;
    const result = this.simulation.runNext();
    this.emit();
    if (result.stoppedBecause !== 'committed') this.pause();
  }

  advance(duration: Millis): void {
    this.pause();
    if (this.simulation.getViewMode() === 'scrubbing') return;
    this.simulation.advance(duration);
    this.emit();
  }

  dispose(): void {
    this.pause();
    this.listeners.clear();
  }

  private tick(): void {
    try {
      if (this.simulation.getViewMode() === 'scrubbing') {
        this.pause();
        return;
      }
      const remaining = Math.max(0, HERO_HORIZON - this.simulation.getHeadTime());
      if (remaining === 0) {
        this.pause();
        return;
      }
      const slice = Math.min(2 * MINUTE * this.speed, remaining);
      this.simulation.advance(slice);
      this.emit();
      if (this.simulation.getHeadTime() >= HERO_HORIZON) this.pause();
    } catch {
      this.pause();
    }
  }

  private emit(): void {
    if (this.snapshot.playing !== this.playing || this.snapshot.speed !== this.speed) {
      this.snapshot = Object.freeze({ playing: this.playing, speed: this.speed });
    }
    for (const listener of this.listeners) listener();
  }
}
