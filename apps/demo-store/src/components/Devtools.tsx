import { useMemo, useState } from 'react';
import type { ComparisonReport, EventFinding, NumericStateFinding } from '@alive-internal/core';
import { api, ApiError } from '../lib/http.js';
import { usePlaybackSnapshot, useSimulationRevision } from '../lib/useSimulation.js';
import { formatVirtualTime } from '../lib/time.js';
import { playback, simulation } from '../runtime.js';
import { ARC_LAMP_ID, HERO_FORK_TIME, HERO_HORIZON, HERO_RESTOCK_QUANTITY, MINUTE } from '../scenario/constants.js';
import type { Product } from '../scenario/types.js';
import { Icon } from './Icons.js';

function eventOccurrence(finding: EventFinding | undefined, side: 'a' | 'b'): string {
  if (!finding) return 'Not measured';
  const occurrence = finding[side];
  if (occurrence.status === 'before-horizon') return `Sold out at ${formatVirtualTime(occurrence.at)}`;
  if (occurrence.status === 'after-horizon') return `After ${formatVirtualTime(occurrence.at)}`;
  return 'No stockout';
}

function stockAtHorizon(report: ComparisonReport | null, side: 'a' | 'b'): number | null {
  const finding = report?.stateFindings.find((item) => item.key === 'arcStock');
  if (!finding || finding.kind !== 'numeric') return null;
  return side === 'a' ? finding.aAtHorizon : finding.bAtHorizon;
}

function Counterfactual({ report }: { report: ComparisonReport }) {
  const stockout = report.eventFindings.find((finding) => finding.key === 'arcStockout');
  const aStock = stockAtHorizon(report, 'a');
  const bStock = stockAtHorizon(report, 'b');
  const causal = report.causalLanguagePermitted && report.causalEventKey === 'arcStockout';
  return <section className="counterfactual-card">
    <div className="counterfactual-title"><div className="cf-spark"><Icon name="spark" size={15}/></div><div><span>Counterfactual</span><strong>What changed?</strong></div></div>
    <div className="cf-columns">
      <div><small>ORIGINAL</small><strong>{eventOccurrence(stockout, 'a')}</strong><span>{aStock ?? '—'} units at 2:00 PM</span></div>
      <Icon name="arrow" size={18}/>
      <div className="cf-future"><small>YOUR TIMELINE</small><strong>{eventOccurrence(stockout, 'b')}</strong><span>{bStock ?? '—'} units at 2:00 PM</span></div>
    </div>
    {causal ? <p className="causal-copy"><Icon name="check" size={15}/><span><b>In this simulation,</b> your restock prevented the Arc Desk Lamp stockout.</span></p> : <p className="causal-copy muted"><Icon name="layers" size={15}/><span>The timelines differ; ALIVE is not authorizing a single-intervention causal sentence.</span></p>}
  </section>;
}

export function Devtools({ comparison }: { comparison: ComparisonReport | null }) {
  useSimulationRevision();
  const playbackState = usePlaybackSnapshot();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const viewMode = simulation.getViewMode();
  const scrub = simulation.getScrubCursor();
  const activeBranchId = simulation.getActiveBranchId();
  const branches = simulation.getBranches();
  const activeBranch = branches.find((branch) => branch.id === activeBranchId);
  const viewTime = scrub?.virtualTime ?? simulation.getHeadTime();
  const maxTime = Math.max(activeBranch?.ranTo ?? simulation.getHeadTime(), viewTime, MINUTE);
  const visibleEvents = useMemo(() => simulation.getEvents().filter((event) => event.virtualTime <= viewTime).slice(-9).reverse(), [activeBranchId, viewTime, simulation.getEvents().length]);
  const baselineFinished = (branches.find((branch) => branch.id === 'branch:root')?.ranTo ?? 0) >= HERO_HORIZON;

  const togglePlay = () => playbackState.playing ? playback.pause() : playback.play();

  const scrubTo = (time: number) => {
    playback.pause();
    setMessage(null);
    if (simulation.getViewMode() === 'scrubbing') simulation.moveScrub({ time });
    else simulation.enterScrub({ time });
  };

  const rewindHero = () => scrubTo(HERO_FORK_TIME);

  const forkAndRestock = async () => {
    const cursor = simulation.getScrubCursor();
    if (!cursor) return;
    playback.pause();
    setBusy(true);
    setMessage(null);
    try {
      simulation.forkAt({ time: cursor.virtualTime }, { name: `Restock at ${formatVirtualTime(cursor.virtualTime)}`, description: 'Add 8 Arc Desk Lamps before the stockout.' });
      await api<Product>(`/api/products/${ARC_LAMP_ID}/restock`, { method: 'POST', body: JSON.stringify({ quantity: HERO_RESTOCK_QUANTITY }) });
      setMessage(`Forked at ${formatVirtualTime(cursor.virtualTime)} and added ${HERO_RESTOCK_QUANTITY} lamps.`);
      playback.setSpeed(5);
      playback.play();
    } catch (error) {
      setMessage(error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Could not create the fork.');
    } finally { setBusy(false); }
  };

  const reset = () => {
    playback.pause();
    simulation.reset();
    setMessage(null);
  };

  const switchBranch = (branchId: string) => {
    playback.pause();
    simulation.switchBranch(branchId);
    setMessage(null);
  };

  return <aside className="alive-panel" aria-label="ALIVE developer tools">
    <div className="dev-head">
      <div className="dev-brand"><span className="dev-orb"><i/></span><div><strong>ALIVE</strong><span>simulation controls</span></div></div>
      <div className={`mode-badge ${viewMode === 'scrubbing' ? 'history' : ''}`}>{viewMode === 'scrubbing' ? 'VIEWING HISTORY' : 'LIVE'}</div>
    </div>

    <section className="clock-section">
      <div className="clock-label"><Icon name="clock" size={15}/><span>Sat 19 Sep</span></div>
      <div className="big-clock">{formatVirtualTime(viewTime)}</div>
      <div className="branch-label"><Icon name="branch" size={14}/><span>{activeBranchId === 'branch:root' ? 'Baseline' : activeBranch?.name ?? 'Alternative branch'}</span></div>
    </section>

    <section className="transport-row">
      <button className="transport-main" onClick={togglePlay} disabled={viewMode === 'scrubbing' || simulation.getHeadTime() >= HERO_HORIZON}>{playbackState.playing ? <Icon name="pause"/> : <Icon name="play"/>}{playbackState.playing ? 'Pause' : simulation.getHeadTime() === 0 ? 'Run launch' : 'Play'}</button>
      <button className="icon-button" title="Next event" onClick={() => playback.step()} disabled={viewMode === 'scrubbing'}><Icon name="step"/></button>
      <button className="icon-button" title="Reset" onClick={reset}><Icon name="rewind"/></button>
    </section>
    <div className="speed-row"><span>Speed</span>{([1,2,5] as const).map((speed) => <button key={speed} className={playbackState.speed === speed ? 'active' : ''} onClick={() => playback.setSpeed(speed)}>{speed}×</button>)}</div>

    <section className="timeline-section">
      <div className="section-title"><span>Timeline</span><strong>{Math.round(viewTime / MINUTE)} min</strong></div>
      <input aria-label="Timeline position" type="range" min={0} max={maxTime} step={MINUTE} value={viewTime} onChange={(event: { target: { value: string } }) => scrubTo(Number(event.target.value))}/>
      <div className="timeline-labels"><span>9:00</span><span>{formatVirtualTime(maxTime)}</span></div>
      {viewMode === 'scrubbing' && <div className="history-actions"><button className="secondary-button compact" onClick={() => simulation.exitScrub()}>Return to live</button><button className="fork-button" onClick={() => void forkAndRestock()} disabled={busy}><Icon name="branch" size={15}/>{busy ? 'Forking…' : `Fork + restock ${HERO_RESTOCK_QUANTITY}`}</button></div>}
      {viewMode !== 'scrubbing' && activeBranchId === 'branch:root' && baselineFinished && <button className="hero-rewind" onClick={rewindHero}><Icon name="rewind" size={15}/><span><b>Try a different future</b>Rewind to 10:30 AM</span><Icon name="chevron" size={15}/></button>}
    </section>

    {branches.length > 1 && <section className="branch-section"><div className="section-title"><span>Branches</span><strong>{branches.length}</strong></div><div className="branch-list">{branches.map((branch) => <button key={branch.id} className={branch.id === activeBranchId ? 'active' : ''} onClick={() => switchBranch(branch.id)}><span className="branch-node"/><div><strong>{branch.id === 'branch:root' ? 'Original timeline' : branch.name ?? 'Alternative future'}</strong><span>through {formatVirtualTime(branch.ranTo)}</span></div>{branch.id === activeBranchId && <Icon name="check" size={15}/>}</button>)}</div></section>}

    {comparison && <Counterfactual report={comparison}/>}
    {message && <div className="dev-message">{message}</div>}

    <section className="event-section">
      <div className="section-title"><span>Event stream</span><strong>{visibleEvents.length ? `${simulation.getEvents().length} total` : 'quiet'}</strong></div>
      <div className="event-stream">{visibleEvents.map((event) => <div className="dev-event" key={`${event.id}-${event.withinCommitOrder}`}><span className={`event-bead ${event.type === 'inventory.stockout' ? 'bad' : event.type === 'inventory.restocked' ? 'good' : ''}`}/><div><strong>{event.type}</strong><span>{event.entityId ?? event.actorId ?? 'system'}</span></div><time>{formatVirtualTime(event.virtualTime)}</time></div>)}{visibleEvents.length === 0 && <div className="quiet-line"><span className="event-bead"/>Waiting for the first event…</div>}</div>
    </section>
    <footer className="dev-foot"><span>seed</span><code>northstar-launch-demo-v1</code></footer>
  </aside>;
}
