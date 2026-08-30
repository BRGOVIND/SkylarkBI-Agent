'use client';

import { useEffect, useRef } from 'react';

/**
 * A compact explanation of what the agent is and why its answers can be
 * trusted. Opened deliberately from the header, never shown unprompted — this
 * is an executive tool, not a tutorial.
 */
export default function About({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Keep focus inside the dialog while it is open.
      if (e.key === 'Tab' && panelRef.current) {
        const items = panelRef.current.querySelectorAll<HTMLElement>('a[href], button');
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="scrim" onClick={onClose}>
      <div
        className="about"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="about-head">
          <h2 id="about-title">About Skylark</h2>
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <p className="about-lead">
          A conversational analyst for your business. Ask in plain language and get an answer drawn
          from your live monday.com boards.
        </p>

        <dl className="about-facts">
          <div>
            <dt>Where the data comes from</dt>
            <dd>
              Two live boards — Deals and Work Orders — read fresh on every question. Skylark only
              ever reads; it cannot change anything in monday.com.
            </dd>
          </div>
          <div>
            <dt>What it can answer</dt>
            <dd>
              Pipeline health, sector performance, revenue and billing, delivery risk, and questions
              that span both boards — such as which customers have active work and open pipeline.
            </dd>
          </div>
          <div>
            <dt>Why the numbers can be trusted</dt>
            <dd>
              Every figure is calculated in code, never by the language model. The model decides what
              to look up and how to explain it; the arithmetic is not its to do.
            </dd>
          </div>
          <div>
            <dt>What it will tell you about gaps</dt>
            <dd>
              Records with missing values are never counted as zero. Totals arrive with the number of
              records behind them, so you can see where the data is thin rather than trusting a
              confident-looking figure.
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}
