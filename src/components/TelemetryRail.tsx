'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The agent's working trace.
 *
 * A question can take 18–80 seconds, so silence is not an option. This shows
 * what the agent is ACTUALLY doing, derived entirely from the tool events the
 * chat stream already emits — nothing here is simulated, and no step is shown
 * before the event that caused it has arrived.
 *
 * Once the answer lands, the rail collapses to a one-line summary that can be
 * reopened. That trace is also the audit trail: it names the operations every
 * reported figure was computed from.
 */

export interface RailStep {
  name: string;
  label: string;
  /** Seconds after the turn started, captured when the event arrived. */
  at: number;
}

/** Real tool names -> what a founder would call that work. */
const STEP_COPY: Record<string, string> = {
  get_board_overview: 'Surveying both boards',
  get_pipeline_metrics: 'Computing pipeline metrics',
  get_sector_analysis: 'Comparing sector performance',
  get_operational_metrics: 'Reading delivery and billing',
  get_risk_analysis: 'Checking operational risks',
  get_cross_board_view: 'Joining deals to delivery',
  search_records: 'Looking up specific records',
  get_data_quality_report: 'Auditing data quality',
  generate_leadership_update: 'Assembling the leadership pack',
};

export function stepCopy(step: RailStep): string {
  return STEP_COPY[step.name] ?? step.label ?? step.name;
}

const fmt = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

/** Ticks once a second while the turn is running. */
function useElapsed(from: number | null, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || from === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, from]);
  return from === null ? 0 : Math.max(0, Math.round((now - from) / 1000));
}

export default function TelemetryRail({
  steps,
  running,
  startedAt,
  totalSeconds,
  hasAnswer,
}: {
  steps: RailStep[];
  running: boolean;
  startedAt: number | null;
  /** Final duration, set when the turn completes. */
  totalSeconds: number | null;
  hasAnswer: boolean;
}) {
  const elapsed = useElapsed(startedAt, running);
  const [open, setOpen] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  // Finished turns collapse to a summary; reopen to inspect the trace.
  if (!running) {
    if (!steps.length) return null;
    return (
      <>
        <button
          className="rail-summary"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${steps.length} data ${steps.length === 1 ? 'step' : 'steps'}${
            totalSeconds !== null ? ` in ${fmt(totalSeconds)}` : ''
          }. Show the agent's working trace.`}
        >
          <svg className="chev" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M3 1 L7 5 L3 9" stroke="currentColor" strokeWidth="1.4" fill="none" />
          </svg>
          {steps.length} {steps.length === 1 ? 'step' : 'steps'}
          {totalSeconds !== null && ` · ${fmt(totalSeconds)}`}
        </button>
        {open && (
          <div className="rail">
            {steps.map((s, i) => (
              <div className="step done" key={i}>
                {stepCopy(s)}
                <span className="step-time">{fmt(s.at)}</span>
              </div>
            ))}
          </div>
        )}
      </>
    );
  }

  // Running. The final line reflects the real phase: the model is either still
  // choosing tools, or it has results and is composing the answer.
  const tail = hasAnswer
    ? 'Writing your answer'
    : steps.length
      ? 'Reading the results'
      : 'Understanding your question';

  return (
    <div className="rail live">
      {steps.map((s, i) => (
        <div className="step done" key={i}>
          {stepCopy(s)}
          <span className="step-time">{fmt(s.at)}</span>
        </div>
      ))}
      <div className="step active" ref={liveRef} role="status" aria-live="polite">
        {tail}
        <span className="step-time">{fmt(elapsed)}</span>
      </div>
    </div>
  );
}
