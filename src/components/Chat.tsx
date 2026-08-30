'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface ToolCall {
  name: string;
  label: string;
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolCall[];
  error?: string;
}

interface Health {
  status: string;
  monday?: string;
  missingEnvVars?: string[];
  message?: string;
  boards?: {
    deals: { usableRecords: number };
    workOrders: { usableRecords: number };
  };
}

const SAMPLES: Array<{ q: string; hint: string }> = [
  { q: 'How is our pipeline looking this quarter?', hint: 'Pipeline health' },
  { q: 'Which sectors are performing best?', hint: 'Sector comparison' },
  { q: "What's our pipeline exposure to the energy sector?", hint: 'Ambiguous — expect a clarification' },
  { q: 'Which customers have both active work and open opportunities?', hint: 'Cross-board join' },
  { q: 'What operational risks should leadership know about?', hint: 'Risk detection' },
  { q: 'Give me a leadership update.', hint: 'Full briefing pack' },
  { q: 'What is our expected revenue?', hint: 'Order book vs billed vs collected' },
  { q: 'How reliable is this data?', hint: 'Data quality report' },
];

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

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
      if (!q || busy) return;

      const history = [...messages, { role: 'user' as const, content: q }];
      setMessages([...history, { role: 'assistant', content: '', tools: [] }]);
      setInput('');
      setBusy(true);

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
                tools: [...(m.tools ?? []), { name: ev.name ?? '', label: ev.label ?? ev.name ?? '' }],
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
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  };

  const configured = health?.status === 'ok';
  const notConfigured = health?.status === 'not_configured';

  return (
    <div className="app">
      <header className="header">
        <div className="mark">SD</div>
        <div>
          <h1>Skylark Business Intelligence</h1>
          <p>Live monday.com Deals &amp; Work Orders &middot; read-only</p>
        </div>
        <div className="status">
          <span
            className={`dot ${configured ? 'ok' : notConfigured ? 'warn' : health ? 'bad' : ''}`}
          />
          {!health
            ? 'Connecting…'
            : configured
              ? `${health.boards?.deals.usableRecords ?? 0} deals · ${health.boards?.workOrders.usableRecords ?? 0} work orders`
              : notConfigured
                ? 'Not configured'
                : 'monday.com unreachable'}
        </div>
      </header>

      <div className="feed" ref={feedRef}>
        {notConfigured && (
          <div className="banner setup">
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
          <div className="banner error">
            <strong>Cannot reach monday.com</strong>
            {health.message}
          </div>
        )}

        {messages.length === 0 ? (
          <div className="empty">
            <h2>Ask about pipeline, delivery, or revenue.</h2>
            <p>
              I query your monday.com Deals and Work Orders boards live, normalise the messy bits, and
              compute every figure deterministically — so numbers come with their coverage, not just a
              total. I never write to monday.com.
            </p>
            <div className="samples-label">Try one</div>
            <div className="samples">
              {SAMPLES.map((s) => (
                <button key={s.q} className="sample" onClick={() => void send(s.q)} disabled={busy}>
                  {s.q}
                  <span>{s.hint}</span>
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
                {!!m.tools?.length && (
                  <div className="tools">
                    {m.tools.map((t, j) => (
                      <span key={j} className="tool-chip">
                        {t.label}
                      </span>
                    ))}
                  </div>
                )}
                {m.error && (
                  <div className="banner error">
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
                          <div className="table-wrap">
                            <table>{children}</table>
                          </div>
                        ),
                        a: ({ children }) => <>{children}</>,
                      }}
                    >
                      {m.content}
                    </ReactMarkdown>
                  </div>
                )}
                {busy && i === messages.length - 1 && !m.content && !m.error && (
                  <div className="thinking">
                    <i />
                    <i />
                    <i />
                    <span style={{ marginLeft: 6 }}>
                      {m.tools?.length ? 'Analysing board data…' : 'Reading monday.com…'}
                    </span>
                  </div>
                )}
              </div>
            ),
          )
        )}
      </div>

      <div className="composer">
        <div className="composer-row">
          <textarea
            ref={taRef}
            rows={1}
            value={input}
            placeholder="Ask a business question…"
            onChange={(e) => {
              setInput(e.target.value);
              autosize(e.target);
            }}
            onKeyDown={onKeyDown}
            disabled={busy}
          />
          <button className="send" onClick={() => void send(input)} disabled={busy || !input.trim()}>
            {busy ? 'Working…' : 'Ask'}
          </button>
        </div>
        <div className="composer-foot">
          {messages.length > 0 && (
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
          <span className="readonly-pill">Read-only · figures computed in code</span>
        </div>
      </div>
    </div>
  );
}
