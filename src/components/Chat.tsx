'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AgentMark from './AgentMark';
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
  const feedRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const intro = useIntro();

  useEffect(() => {
    // no-store: a cached health response would misreport the connection state.
    fetch('/api/health', { cache: 'no-store' })
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: 'error', message: 'Could not reach the server.' }));
  }, []);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return; // empty input and double-submit guard

      const startedAt = Date.now();
      const history = [...messages, { role: 'user' as const, content: q }];
      setMessages([...history, { role: 'assistant', content: '', steps: [], startedAt }]);
      setInput('');
      setBusy(true);
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

  return (
    <>
      <Opening playing={intro} />

      <div className={`app${intro ? ' boot' : ''}`}>
        <header className="header">
          <div className="header-id">
            <AgentMark size={26} />
            <h1>
              Skylark <span>Intelligence</span>
            </h1>
          </div>

          <div className="status">
            <span
              className={`dot ${configured ? 'live' : notConfigured ? 'warn' : health ? 'bad' : ''}`}
            />
            <span>
              {!health ? (
                'Connecting'
              ) : configured ? (
                <>
                  <b>{health.boards?.deals.usableRecords ?? 0}</b> deals
                  <span className="status-text">
                    {' · '}
                    <b>{health.boards?.workOrders.usableRecords ?? 0}</b> work orders
                  </span>
                </>
              ) : notConfigured ? (
                'Not configured'
              ) : (
                'monday.com unreachable'
              )}
            </span>
          </div>
        </header>

        <main className="feed" ref={feedRef}>
          {notConfigured && (
            <div className="banner setup" role="status">
              <strong>Setup required</strong>
              This deployment is missing{' '}
              {health.missingEnvVars?.map((v, i) => (
                <span key={v}>
                  {i > 0 && ', '}
                  <code>{v}</code>
                </span>
              ))}
              . Set them in the hosting environment and redeploy — see the README.
            </div>
          )}
          {health?.status === 'error' && (
            <div className="banner error" role="status">
              <strong>Cannot reach monday.com</strong>
              {health.message}
            </div>
          )}

          {empty ? (
            <div className="hero stagger">
              <h2 className="hero-line">
                Your business, <em>understood</em>.
              </h2>
              <p className="hero-sub">
                Ask across your deals and work orders in plain language. Every figure is computed in
                code from live monday.com data — and comes with what it was based on, so you can see
                where the numbers are thin.
              </p>
              <div>
                <div className="prompts-label">Start with one of these</div>
                <div className="prompts">
                  {PROMPTS.map((p) => (
                    <button
                      key={p.q}
                      className="prompt"
                      onClick={() => void send(p.q)}
                      disabled={busy}
                    >
                      {p.q}
                      <small>{p.hint}</small>
                    </button>
                  ))}
                </div>
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
        </main>

        <div className="composer">
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
                  setMessages([]);
                  setInput('');
                  taRef.current?.focus();
                }}
                disabled={busy}
              >
                New conversation
              </button>
            )}
            <span className="foot-note">
              Read-only · every figure computed in code
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
