/**
 * Skylark BI Agent mark.
 *
 * A derivative of the Skylark Drones bird, not a copy of it. The original's DNA
 * is kept — orange, folded triangular planes separated by negative space, a
 * bird climbing to the right — and rebuilt with a detached forward shard that
 * reads as a sensor leading the flight.
 *
 * The mark stays still. Its agent quality is expressed in motion instead: it
 * flies in on load and its colour drives the telemetry rail while the agent
 * works. Decoration on the mark itself was tried and cut — at small sizes it
 * read as smudges rather than signal.
 */

export default function AgentMark({
  size = 28,
  title,
}: {
  size?: number;
  /** Supply for a standalone accessible image; omit when decorative. */
  title?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role={title ? 'img' : 'presentation'}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      style={{ display: 'block', flexShrink: 0 }}
    >
      {/* forward sensor shard (head) */}
      <path d="M12 30 L31 21 L27 42 Z" fill="#F0552B" />
      {/* wing — the dominant climbing plane */}
      <path d="M34 47 L94 9 L60 53 Z" fill="#F0552B" />
      {/* body */}
      <path d="M29 46 L56 60 L31 74 Z" fill="#F0552B" />
      {/* tail */}
      <path d="M48 65 L68 61 L54 97 Z" fill="#F0552B" />
    </svg>
  );
}
