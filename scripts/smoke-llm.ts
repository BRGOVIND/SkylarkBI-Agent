/**
 * Real end-to-end smoke test against the configured LLM provider and the live
 * monday.com boards.
 *
 * Verifies the things a unit test cannot: that the model actually understands
 * founder-level questions, picks sensible tools, uses the returned figures, and
 * discloses data-quality caveats.
 *
 * IMPORTANT — token budget. Each scenario costs TWO model requests (one to
 * choose a tool, one to answer with its result), and every request re-sends the
 * system prompt plus all nine tool schemas (~2,800 tokens). One scenario is
 * therefore ~7,000-10,000 tokens. Groq's free tier allows 8,000 tokens PER
 * MINUTE, so scenarios must be spaced roughly a minute apart. Running them
 * back-to-back is guaranteed to hit a 429.
 *
 *   npx tsx scripts/smoke-llm.ts --probe    # ~30 tokens: report actual limits
 *   npx tsx scripts/smoke-llm.ts --quick    # one scenario only
 *   npx tsx scripts/smoke-llm.ts --only 3   # one specific scenario
 *   npx tsx scripts/smoke-llm.ts            # all six, paced for the TPM window
 *   npx tsx scripts/smoke-llm.ts --gap 90   # widen the spacing (seconds)
 */

import { runAgent, type AgentEvent } from '../src/lib/agent/run';
import { configStatus, loadConfig } from '../src/lib/config';
import { createProvider } from '../src/lib/agent/factory';
import { GroqProvider } from '../src/lib/agent/providers/groq';
import { GeminiProvider } from '../src/lib/agent/providers/gemini';

interface Scenario {
  question: string;
  checks: string;
  expectTools: string[];
  expectMentions?: string[];
}

const SCENARIOS: Scenario[] = [
  {
    question: 'How is our pipeline looking?',
    checks: 'understands a founder question, picks the pipeline tool, uses the figures',
    expectTools: ['get_pipeline_metrics', 'generate_leadership_update', 'get_board_overview'],
  },
  {
    question: 'Which sectors are performing best?',
    checks: 'sector comparison across both boards',
    expectTools: ['get_sector_analysis'],
  },
  {
    question: 'Which customers have both active work and open pipeline opportunities?',
    checks: 'cross-board join',
    expectTools: ['get_cross_board_view'],
  },
  {
    question: 'How complete is the deal value data? Give me the caveats.',
    checks: 'data-quality disclosure',
    expectTools: ['get_data_quality_report', 'get_pipeline_metrics'],
    expectMentions: ['no deal value', 'missing', 'incomplete', 'coverage', 'excluded'],
  },
  {
    question: "What's our pipeline exposure to the energy sector?",
    checks: 'clarification — "energy" is not a sector in this data',
    expectTools: ['get_board_overview', 'get_sector_analysis', 'get_pipeline_metrics'],
    expectMentions: ['renewables', 'powerline', 'not a sector', 'did you mean', 'energy'],
  },
  {
    question: 'What operational risks should leadership know about?',
    checks: 'risk detection',
    expectTools: ['get_risk_analysis', 'generate_leadership_update'],
  },
];

const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------- probe ---------------------------------- */

/**
 * Cheapest possible live check: one tiny request with no tools, purely to read
 * the rate-limit headers back. Costs ~30 tokens, so it works even when the
 * per-minute budget is nearly exhausted.
 */
async function probe(): Promise<void> {
  const cfg = loadConfig();
  console.log(`Probing ${cfg.llm.provider} with model ${cfg.llm.model} (one minimal request)…
`);

  let seen: Record<string, string | undefined> = {};
  const minimal = {
    system: 'Reply with the single word: ok',
    tools: [],
    messages: [{ role: 'user' as const, text: 'ok' }],
    maxTokens: 16,
  };

  const provider =
    cfg.llm.provider === 'groq'
      ? new GroqProvider({
          apiKey: cfg.llm.apiKey,
          model: cfg.llm.model,
          maxAttempts: 1,
          onRateLimit: (info) => {
            seen = info as Record<string, string | undefined>;
          },
        })
      : cfg.llm.provider === 'gemini'
        ? new GeminiProvider({ apiKey: cfg.llm.apiKey, model: cfg.llm.model, maxAttempts: 1 })
        : createProvider(cfg);

  let ok = false;
  try {
    const turn = await provider.complete(minimal);
    ok = true;
    console.log(`  request succeeded — model replied: ${JSON.stringify(turn.text.join(' ').slice(0, 40))}`);
  } catch (err) {
    console.log(`  request FAILED: ${err instanceof Error ? err.message : String(err)}`);
    const rl = (err as { rateLimit?: Record<string, string | undefined> }).rateLimit;
    if (rl) seen = rl;
  }

  if (Object.values(seen).some(Boolean)) {
    console.log(`\nRate-limit budget reported by the provider:`);
    const rows: Array<[string, string | undefined]> = [
      ['requests allowed', seen.limitRequests],
      ['requests remaining', seen.remainingRequests],
      ['requests reset in', seen.resetRequests],
      ['tokens allowed (per minute)', seen.limitTokens],
      ['tokens remaining', seen.remainingTokens],
      ['tokens reset in', seen.resetTokens],
    ];
    for (const [k, v] of rows) console.log(`  ${k.padEnd(30)} ${v ?? '(not reported)'}`);

    const tpm = Number(seen.limitTokens);
    if (Number.isFinite(tpm) && tpm > 0) {
      console.log(`
  One smoke scenario costs roughly 7,000-10,000 tokens.`);
      console.log(
        tpm < 12_000
          ? `  At ${tpm} tokens/minute you can run about ONE scenario per minute — use --quick.`
          : `  At ${tpm} tokens/minute the full run should complete comfortably.`,
      );
    }
  } else if (cfg.llm.provider === 'gemini') {
    // Google does not return x-ratelimit-* headers on this endpoint; the
    // authoritative figures live in AI Studio.
    console.log(`\n  Gemini does not return rate-limit headers on this endpoint.`);
    console.log('  View your live limits at https://aistudio.google.com/rate-limit');
    if (ok) {
      console.log(`\n  The key, model and endpoint are all working. Next: --quick`);
    }
  }
}

/* ------------------------------- scenarios -------------------------------- */

async function run(s: Scenario, label: number): Promise<boolean> {
  console.log(`\n${'─'.repeat(76)}\n[${label}] ${s.question}`);
  console.log(`    checks: ${s.checks}`);

  const tools: string[] = [];
  const chunks: string[] = [];
  let error: string | null = null;
  const started = Date.now();

  for await (const ev of runAgent([{ role: 'user', content: s.question }]) as AsyncGenerator<AgentEvent>) {
    if (ev.type === 'tool') tools.push(ev.name);
    else if (ev.type === 'text') chunks.push(ev.text);
    else if (ev.type === 'error') error = ev.message;
  }

  const answer = chunks.join('\n\n').trim();
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (error) {
    console.log(`    time:   ${elapsed}s`);
    console.log(`    FAIL    ${error}`);
    if (/rate limit|429/i.test(error)) {
      console.log(`    note:   this is a provider budget limit, not an agent fault.`);
      console.log(`            wait for the window to reset, or run with --quick.`);
    }
    return false;
  }

  const toolOk = tools.some((t) => s.expectTools.includes(t));
  const lower = answer.toLowerCase();
  const mentionOk = !s.expectMentions || s.expectMentions.some((m) => lower.includes(m));
  const hasAnswer = answer.length > 40;

  console.log(`    tools:  ${tools.length ? tools.join(', ') : '(none)'}`);
  console.log(`    time:   ${elapsed}s`);
  console.log(`    answer: ${answer.slice(0, 400).replace(/\n/g, '\n            ')}${answer.length > 400 ? '…' : ''}`);

  const pass = toolOk && mentionOk && hasAnswer;
  const notes = [
    toolOk ? null : `expected one of [${s.expectTools.join(', ')}]`,
    mentionOk ? null : `expected a mention of [${s.expectMentions?.join(' | ')}]`,
    hasAnswer ? null : 'answer too short',
  ].filter(Boolean);
  console.log(`    ${pass ? 'PASS' : `FAIL — ${notes.join('; ')}`}`);
  return pass;
}

/* --------------------------------- main ----------------------------------- */

async function main() {
  const status = configStatus();
  if (!status.ok) {
    console.error(`Not configured. Missing: ${status.missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`Provider: ${status.provider}   Model: ${status.model}`);

  if (has('probe')) {
    await probe();
    return;
  }

  const onlyIdx = arg('only') ? Number(arg('only')) : null;
  // Groq's 8k TPM ceiling needs a full window between scenarios; other
  // providers are far more generous, so they only need light spacing.
  const defaultGap = configStatus().provider === 'groq' ? 65 : 8;
  const gapSeconds = Number(arg('gap') ?? defaultGap);

  let list: Array<{ s: Scenario; label: number }>;
  if (has('quick')) {
    list = [{ s: SCENARIOS[0], label: 1 }];
  } else if (onlyIdx) {
    const s = SCENARIOS[onlyIdx - 1];
    if (!s) {
      console.error(`--only must be between 1 and ${SCENARIOS.length}`);
      process.exit(1);
    }
    list = [{ s, label: onlyIdx }];
  } else {
    list = SCENARIOS.map((s, i) => ({ s, label: i + 1 }));
  }

  if (list.length > 1) {
    console.log(
      `Running ${list.length} scenarios sequentially, ${gapSeconds}s apart ` +
        `(each costs ~7-10k tokens; free-tier budgets are per minute).`,
    );
    console.log(`Estimated wall time: ~${Math.ceil((list.length * (gapSeconds + 12)) / 60)} min.`);
  }

  let passed = 0;
  for (const [i, item] of list.entries()) {
    if (await run(item.s, item.label)) passed++;
    // Space out the next scenario so the per-minute token window can refill.
    if (i < list.length - 1) {
      console.log(`\n    …waiting ${gapSeconds}s for the token window to reset`);
      await sleep(gapSeconds * 1000);
    }
  }

  console.log(`\n${'─'.repeat(76)}\n${passed}/${list.length} scenarios passed.`);
  process.exit(passed === list.length ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
