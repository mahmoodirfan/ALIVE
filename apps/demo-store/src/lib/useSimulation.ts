import { useEffect, useState, useSyncExternalStore } from 'react';
import { playback, simulation } from '../runtime.js';

export function useSimulationRevision(): number {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const bump = () => setRevision((value) => value + 1);
    const offCommit = simulation.on('committed', bump);
    const offTimeline = simulation.on('timeline:changed', bump);
    const offPlayback = playback.subscribe(bump);
    return () => { offCommit(); offTimeline(); offPlayback(); };
  }, []);
  return revision;
}

export function usePlaybackSnapshot() {
  return useSyncExternalStore(playback.subscribe, playback.getSnapshot, playback.getSnapshot);
}
