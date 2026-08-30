'use client';

import { useEffect, useState } from 'react';
import AgentMark from './AgentMark';

/**
 * The agent's own status, replacing a generic coloured dot.
 *
 * The mark sits inside a faint ring. When the agent is actually working, a
 * short bright arc sweeps that ring at a constant rate — an instrument scan
 * rather than a spinner — and the elapsed time counts up beside it. The moment
 * work finishes the ring pulses once and settles.
 *
 * Every state is driven by real application state: the health response and the
 * live `busy` flag. Nothing animates when nothing is happening.
 */

export type AgentState = 'connecting' | 'connected' | 'working' | 'ready' | 'setup' | 'offline';

const LABEL: Record<AgentState, string> = {
  connecting: 'Connecting',
  connected: 'Connected',
  working: 'Working',
  ready: 'Ready',
  setup: 'Setup needed',
  offline: 'No data source',
};

function useElapsed(from: number | null, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || from === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, from]);
  return from === null ? 0 : Math.max(0, Math.round((now - from) / 1000));
}

export default function AgentStatus({
  state,
  startedAt,
  detail,
  size = 30,
}: {
  state: AgentState;
  /** When the current turn began, for the elapsed counter. */
  startedAt?: number | null;
  /** Quiet trailing text, e.g. record counts. Never a secret. */
  detail?: React.ReactNode;
  size?: number;
}) {
  const working = state === 'working';
  const elapsed = useElapsed(startedAt ?? null, working);

  return (
    <div className="agent-status" data-state={state}>
      <div className="orbit" style={{ width: size, height: size }} aria-hidden="true">
        <svg className="orbit-ring" viewBox="0 0 40 40">
          {/* the instrument's resting ring */}
          <circle cx="20" cy="20" r="17" className="ring-base" />
          {/* a single short arc, swept only while the agent is working */}
          <circle cx="20" cy="20" r="17" className="ring-sweep" />
        </svg>
        <div className="orbit-core">
          <AgentMark size={Math.round(size * 0.52)} />
        </div>
      </div>

      <div className="agent-status-text">
        <span className="agent-status-label" role="status" aria-live="polite">
          {LABEL[state]}
          {working && <b> {elapsed}s</b>}
        </span>
        {detail && !working && <span className="agent-status-detail">{detail}</span>}
      </div>
    </div>
  );
}
