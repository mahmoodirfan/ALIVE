import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSimulation } from '@alive-internal/core';
import { PlaybackController } from '../src/lib/playback.js';
import { createProductLaunchScenario } from '../src/scenario/productLaunch.js';
import { HERO_HORIZON, MINUTE } from '../src/scenario/constants.js';

afterEach(() => vi.useRealTimers());

describe('browser playback boundary', () => {
  it('keeps React snapshots stable while notifying clock-only advances', () => {
    vi.useFakeTimers();
    const sim = createSimulation({ scenario: createProductLaunchScenario(), seed: 'northstar-launch-demo-v1' });
    const playback = new PlaybackController(sim);
    const notify = vi.fn();
    playback.subscribe(notify);
    const initial = playback.getSnapshot();
    expect(playback.getSnapshot()).toBe(initial);
    playback.setSpeed(1);
    expect(playback.getSnapshot()).toBe(initial);
    playback.play();
    const running = playback.getSnapshot();
    expect(running).not.toBe(initial);
    expect(running.playing).toBe(true);
    notify.mockClear();
    vi.advanceTimersByTime(180);
    expect(sim.getHeadTime()).toBe(2 * MINUTE);
    expect(playback.getSnapshot()).toBe(running);
    expect(notify).toHaveBeenCalled();
    playback.pause();
    expect(playback.getSnapshot().playing).toBe(false);
    vi.advanceTimersByTime(180);
    expect(sim.getHeadTime()).toBe(2 * MINUTE);
    playback.setSpeed(5);
    playback.play();
    vi.advanceTimersByTime(6000);
    expect(sim.getHeadTime()).toBe(HERO_HORIZON);
    expect(playback.getSnapshot().playing).toBe(false);
    playback.dispose();
    sim.dispose();
  });
});
