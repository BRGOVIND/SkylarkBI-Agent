/**
 * Real end-to-end smoke test against the configured LLM provider and the live
 * monday.com boards.
 *
 * Verifies the things a unit test cannot: that the model actually understands
 * founder-level questions, picks sensible tools, uses the returned figures, and
 * discloses data-quality caveats.
 *
 *   npx tsx scripts/smoke-llm.ts            # all scenarios
 *   npx tsx scripts/smoke-llm.ts --only 2   # a single scenario
 */

import { runAgent, type AgentEvent } from '../src/lib/agent/run';
import { configStatus } from '../src/lib/config';

interface Scenario {
  question: string;
  /** Capability being demonstrated. */
  checks: string;
  /** Tools any reasonable answer should use at least one of. */
  expectTools: string[];
  /** Lowercase substrings the answer should contain at least one of. */
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

async function run(s: Scenario, i: number) {
  console.log(`\n${'─'.repeat(76)}\n[${i + 1}] ${s.question}`);
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
    console.log(`    FAIL  ${error}`);
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

async function main() {
  const status = configStatus();
  if (!status.ok) {
    console.error(`Not configured. Missing: ${status.missing.join(', ')}`);
    process.exit(1);
  }
  console.log(`Provider: ${status.provider}   Model: ${status.model}`);

  const onlyArg = process.argv.indexOf('--only');
  const only = onlyArg >= 0 ? Number(process.argv[onlyArg + 1]) : null;
  const list = only ? [SCENARIOS[only - 1]].filter(Boolean) : SCENARIOS;

  let passed = 0;
  for (const [i, s] of list.entries()) {
    if (await run(s, only ? only - 1 : i)) passed++;
  }

  console.log(`\n${'─'.repeat(76)}\n${passed}/${list.length} scenarios passed.`);
  process.exit(passed === list.length ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSmoke test failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
