export function StatusPill({ tone, children }: { tone: 'good' | 'warn' | 'bad' | 'neutral' | 'blue'; children: React.ReactNode }) {
  return <span className={`status-pill status-${tone}`}>{children}</span>;
}
