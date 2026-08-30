'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import About from './About';
import AgentMark from './AgentMark';
import AgentStatus, { type AgentState } from './AgentStatus';
import Footer from './Footer';
import Opening, { useIntro } from './Opening';
import TelemetryRail, { type RailStep } from './TelemetryRail';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Real tool events, in the order the stream reported them. */
  steps?: RailStep[];
  error?: string;
  startedAt?: number;
  totalSeconds?: number;
}

interface Health {
  status: string;
  monday?: string;
  missingEnvVars?: string[];
  message?: string;
  llm?: { provider: string | null; model: string | null };
  boards?: {
    deals: { usableRecords: number };
    workOrders: { usableRecords: number };
  };
}

const PROMPTS: Array<{ q: string; hint: string }> = [
  { q: 'How is our pipeline looking?', hint: 'Open value, weighted, win rate' },
  { q: 'Which sectors are performing best?', hint: 'Across deals and delivery' },
  { q: 'Which customers have both active work and open pipeline?', hint: 'Joins the two boards' },
  { q: 'What operational risks should leadership know about?', hint: 'Overdue, stalled, unbilled' },
  { q: 'How complete is the deal value data?', hint: 'Coverage and caveats' },
  { q: 'What is our expected revenue?', hint: 'Order book vs billed vs collected' },
];

/**
 * A figure the agent chose to emphasise gets the data face. Presentation only —
 * the value is whatever the deterministic analytics produced upstream, and is
 * never parsed, reformatted or recomputed here.
 */
const FIGURE = /[\d₹]/;

function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return '';
}

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  /** Brief "Ready" beat after a turn completes, then back to Connected. */
  const [justFinished, setJustFinished] = useState(false);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const intro = useIntro();

  useEffect(() => {
    // no-store: a cached health response would misreport the connection state.
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'error', message: 'Could not reach the server.' }));
  }, []);

  // Keep the newest message in view. The page scrolls, not an inner pane.
  useEffect(() => {
    if (!messages.length) return;
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return; // empty input and double-submit guard

      // Asking from the hero should carry you into the workspace.
      workspaceRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

      const startedAt = Date.now();
      const history = [...messages, { role: 'user' as const, content: q }];
      setMessages([...history, { role: 'assistant', content: '', steps: [], startedAt }]);
      setInput('');
      setBusy(true);
      setJustFinished(false);
      if (taRef.current) taRef.current.style.height = 'auto';

      const patch = (fn: (m: Message) => Message) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = fn(next[next.length - 1]);
          return next;
        });

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: history.map(({ role, content }) => ({ role, content })),
          }),
        });

        if (!res.ok || !res.body) {
          const err = await res.json().catch(() => ({ error: `Request failed (${res.status}).` }));
          patch((m) => ({ ...m, error: err.error ?? 'The request failed.' }));
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let ev: { type: string; text?: string; label?: string; name?: string; message?: string };
            try {
              ev = JSON.parse(line);
            } catch {
              continue;
            }
            if (ev.type === 'tool') {
              patch((m) => ({
                ...m,
                steps: [
                  ...(m.steps ?? []),
                  {
                    name: ev.name ?? '',
                    label: ev.label ?? ev.name ?? '',
                    at: Math.round((Date.now() - startedAt) / 1000),
                  },
                ],
              }));
            } else if (ev.type === 'text') {
              patch((m) => ({ ...m, content: m.content ? `${m.content}\n\n${ev.text}` : ev.text ?? '' }));
            } else if (ev.type === 'error') {
              patch((m) => ({ ...m, error: ev.message }));
            }
          }
        }
      } catch {
        patch((m) => ({ ...m, error: 'Lost connection to the agent. Please try again.' }));
      } finally {
        patch((m) => ({ ...m, totalSeconds: Math.round((Date.now() - startedAt) / 1000) }));
        setBusy(false);
        setJustFinished(true);
        setTimeout(() => setJustFinished(false), 2600);
      }
    },
    [busy, messages],
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(input);
    }
  };

  const autosize = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(168, el.scrollHeight)}px`;
  };

  const configured = health?.status === 'ok';
  const notConfigured = health?.status === 'not_configured';
  const empty = messages.length === 0;
  const turnStart = messages.length ? messages[messages.length - 1].startedAt ?? null : null;

  const agentState: AgentState = busy
    ? 'working'
    : !health
      ? 'connecting'
      : notConfigured
        ? 'setup'
        : !configured
          ? 'offline'
          : justFinished
            ? 'ready'
            : 'connected';

  const records = configured ? (
    <>
      {health.boards?.deals.usableRecords ?? 0} deals · {health.boards?.workOrders.usableRecords ?? 0}{' '}
      work orders
    </>
  ) : null;

  return (
    <>
      <Opening playing={intro} />
      <About open={aboutOpen} onClose={() => setAboutOpen(false)} />

      <div className={`page${intro ? ' boot' : ''}`}>
        {/* ---------------------------------------------------------------- */}
        {/* 1 — the agent introduces itself                                   */}
        {/* ---------------------------------------------------------------- */}
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-inner">
            <div className="hero-mark">
              <AgentMark size={44} title="Skylark BI Agent" />
            </div>

            <h1 id="hero-title" className="hero-title">
              Your business,
              <br />
              <em>understood</em>.
            </h1>

            <p className="hero-sub">
              Ask questions across your deals and work orders and get answers grounded in your live
              business data — with the coverage behind every number.
            </p>

            <div className="hero-status">
              <AgentStatus state={agentState} startedAt={turnStart} detail={records} size={34} />
            </div>

            <a className="scroll-cue" href="#workspace" aria-label="Go to the workspace">
              <span>Ask Skylark</span>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M6 1v9M2.5 6.5L6 10l3.5-3.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>
        </section>

        {/* ---------------------------------------------------------------- */}
        {/* 2 — the intelligence workspace                                    */}
        {/* ---------------------------------------------------------------- */}
        <section className="workspace" id="workspace" ref={workspaceRef} aria-label="Skylark workspace">
          <header className="bar">
            <div className="bar-inner">
              <div className="bar-id">
                <AgentMark size={22} />
                <span className="bar-name">
                  Skylark <span>Intelligence</span>
                </span>
              </div>

              <div className="bar-tools">
                <AgentStatus state={agentState} startedAt={turnStart} detail={records} size={26} />
                <button className="ghost-btn" onClick={() => setAboutOpen(true)}>
                  About
                </button>
              </div>
            </div>
          </header>

          <div className="feed">
            {notConfigured && (
              <div className="banner setup" role="status">
                <strong>Skylark is not connected to its business data yet</strong>
                Add the data-source and model configuration in the hosting environment, then
                redeploy. The exact settings are listed in the project&rsquo;s deployment guide.
              </div>
            )}
            {health?.status === 'error' && (
              <div className="banner error" role="status">
                <strong>Skylark could not reach its business data</strong>
                The data source did not respond. This is usually a configuration or connectivity
                problem rather than a fault in your question &mdash; try again shortly.
              </div>
            )}

            {empty ? (
              <div className="starter">
                <h2 className="starter-title">What would you like to know?</h2>
                <div className="prompts">
                  {PROMPTS.map((p) => (
                    <button
                      key={p.q}
                      className="prompt"
                      onClick={() => void send(p.q)}
                      disabled={busy}
                    >
                      <span className="prompt-q">{p.q}</span>
                      <span className="prompt-hint">{p.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="msg msg-user">
                    <div className="bubble">{m.content}</div>
                  </div>
                ) : (
                  <div key={i} className="msg msg-agent">
                    <TelemetryRail
                      steps={m.steps ?? []}
                      running={busy && i === messages.length - 1}
                      startedAt={m.startedAt ?? null}
                      totalSeconds={m.totalSeconds ?? null}
                      hasAnswer={!!m.content}
                    />

                    {m.error && (
                      <div className="banner error" role="alert">
                        <strong>Something went wrong</strong>
                        {m.error}
                      </div>
                    )}

                    {m.content && (
                      <div className="body">
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            table: ({ children }) => (
                              <div className="table-wrap" tabIndex={0} role="group">
                                <table>{children}</table>
                              </div>
                            ),
                            strong: ({ children }) => {
                              const t = textOf(children);
                              return (
                                <strong className={FIGURE.test(t) ? 'metric' : undefined}>
                                  {children}
                                </strong>
                              );
                            },
                            a: ({ children }) => <>{children}</>,
                          }}
                        >
                          {m.content}
                        </ReactMarkdown>
                      </div>
                    )}
                  </div>
                ),
              )
            )}
            <div ref={endRef} />
          </div>

          <div className="composer">
            <div className="composer-inner">
              <div className="composer-row">
              <textarea
                ref={taRef}
                rows={1}
                value={input}
                aria-label="Ask a business question"
                placeholder="Ask about pipeline, sectors, delivery or risk…"
                onChange={(e) => {
                  setInput(e.target.value);
                  autosize(e.target);
                }}
                onKeyDown={onKeyDown}
                disabled={busy}
              />
              <button
                className="send"
                onClick={() => void send(input)}
                disabled={busy || !input.trim()}
                aria-label={busy ? 'Working' : 'Send question'}
              >
                <span className="send-label">{busy ? 'Working' : 'Ask'}</span>
                <svg width="13" height="13" viewBox="0 0 14 14" aria-hidden="true">
                  <path
                    d="M1 7h11M8 3l4 4-4 4"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

              <div className="composer-foot">
                {!empty && (
                  <button
                    className="linkish"
                    onClick={() => {
                      // Clears client state only; nothing is persisted, so a
                      // new conversation cannot inherit the previous context.
                      setMessages([]);
                      setInput('');
                      taRef.current?.focus();
                    }}
                    disabled={busy}
                  >
                    New conversation
                  </button>
                )}
                <span className="foot-note">Read-only · every figure computed in code</span>
              </div>
            </div>
          </div>
        </section>

        <Footer />
      </div>
    </>
  );
}
