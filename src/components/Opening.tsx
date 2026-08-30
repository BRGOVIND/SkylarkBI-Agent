'use client';

import { useEffect, useState } from 'react';
import AgentMark from './AgentMark';

/**
 * The agent arriving.
 *
 * The mark flies in from off-screen along a climbing path, settles, leaves a
 * brief trace, and the workspace resolves behind it. Roughly two seconds, once
 * per browser session — long enough to register, short enough never to be in
 * the way.
 *
 * It is purely an overlay: the interface underneath is already mounted and
 * interactive, so a failed or skipped animation costs nothing.
 */

const SEEN_KEY = 'skylark.opened';

/**
 * Decided once per page load, not per component, so the overlay and the
 * workspace entrance cannot disagree about whether this is a first visit.
 */
let firstVisit: boolean | null = null;

function isFirstVisit(): boolean {
  if (firstVisit !== null) return firstVisit;
  try {
    firstVisit = sessionStorage.getItem(SEEN_KEY) !== '1';
    if (firstVisit) sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Private mode or storage disabled: play it once, it is harmless.
    firstVisit = true;
  }
  return firstVisit;
}

/** True on the session's first render — stages the workspace entrance. */
export function useIntro(): boolean {
  const [intro, setIntro] = useState(false);

  useEffect(() => {
    if (!isFirstVisit()) return;
    setIntro(true);
    const t = setTimeout(() => setIntro(false), 2200);
    return () => clearTimeout(t);
  }, []);

  return intro;
}

export default function Opening({ playing }: { playing: boolean }) {
  if (!playing) return null;

  return (
    <div className="opening" aria-hidden="true">
      <div className="opening-inner">
        <div className="opening-mark">
          <AgentMark size={64} />
        </div>
        <div className="opening-trace" />
        <div className="opening-word">Skylark intelligence</div>
      </div>
    </div>
  );
}
