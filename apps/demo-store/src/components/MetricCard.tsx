import type { ReactNode } from 'react';

export function MetricCard({ label, value, meta, icon }: { label: string; value: string; meta: ReactNode; icon: ReactNode }) {
  return <article className="metric-card">
    <div className="metric-icon">{icon}</div>
    <div className="metric-label">{label}</div>
    <div className="metric-value">{value}</div>
    <div className="metric-meta">{meta}</div>
  </article>;
}
