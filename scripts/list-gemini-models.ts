/**
 * Lists the Gemini models actually available to the configured GEMINI_API_KEY,
 * and recommends one for this agent.
 *
 * The 404 we hit means the key reached Google but the requested model id is not
 * available to it. Rather than guessing another name, this asks Google.
 *
 * The key is read from the environment and sent in the `x-goog-api-key` header
 * (never in a URL, never printed, never logged).
 *
 *   npx tsx scripts/list-gemini-models.ts            # list + recommend
 *   npx tsx scripts/list-gemini-models.ts --all      # include non-chat models
 *   npx tsx scripts/list-gemini-models.ts --verify   # prove tool calling works
 *   npx tsx scripts/list-gemini-models.ts --verify --model gemini-3.7-flash
 */

import { GeminiProvider } from '../src/lib/agent/providers/gemini';

const KEY = process.env.GEMINI_API_KEY?.trim();
const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const NATIVE_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const COMPAT_MODELS = 'https://generativelanguage.googleapis.com/v1beta/openai/models';

interface NativeModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

/** Native ListModels, following pagination. Capability metadata lives here. */
async function listNative(): Promise<NativeModel[]> {
  const out: NativeModel[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${NATIVE_BASE}/models`);
    url.searchParams.set('pageSize', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url, { headers: { 'x-goog-api-key': KEY as string } });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`ListModels failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
    }
    const body = JSON.parse(text) as { models?: NativeModel[]; nextPageToken?: string };
    out.push(...(body.models ?? []));
    pageToken = body.nextPageToken;
  } while (pageToken);

  return out;
}

/**
 * The OpenAI-compatibility endpoint's own model list. This is authoritative for
 * what our adapter can pass as `model`, because that is the endpoint it calls.
 */
async function listCompat(): Promise<string[]> {
  const res = await fetch(COMPAT_MODELS, { headers: { Authorization: `Bearer ${KEY}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`compat /models failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
  const body = JSON.parse(text) as { data?: Array<{ id: string }> };
  return (body.data ?? []).map((m) => m.id);
}

/** Strip the `models/` prefix the native API uses; the compat layer omits it. */
const bare = (name: string) => name.replace(/^models\//, '');

/**
 * Ranks models for THIS agent: a conversational BI tool that needs reliable
 * function calling and good instruction following, on a free tier.
 *
 * Flash-class is the target — Pro is stronger at instruction following but has
 * markedly tighter free-tier quotas, and Lite trades away the instruction
 * following this agent's caveat rules depend on.
 */
function score(id: string): number {
  if (!/^gemini-/.test(id)) return -1;
  // Exclude non-chat and specialised variants.
  if (/embedding|aqa|imagen|veo|tts|native-audio|image|vision-only/.test(id)) return -1;

  let s = 0;
  const version = id.match(/^gemini-(\d+)(?:\.(\d+))?/);
  if (version) s += Number(version[1]) * 100 + Number(version[2] ?? 0) * 10;

  if (/-flash/.test(id)) s += 50; // preferred class
  else if (/-pro/.test(id)) s += 20; // capable but quota-tight on free tier
  if (/-lite/.test(id)) s -= 25; // weaker instruction following
  if (/preview|exp|experimental|thinking/.test(id)) s -= 40; // prefer stable
  if (/\d{2}-\d{2}$/.test(id)) s -= 10; // dated snapshot over the stable alias

  return s;
}

/** One real tool-calling request, proving the model works with OUR adapter. */
async function verify(model: string): Promise<boolean> {
  console.log(`\nVerifying tool calling on "${model}" with the real adapter…`);
  const provider = new GeminiProvider({ apiKey: KEY as string, model, maxAttempts: 1 });
  try {
    const turn = await provider.complete({
      system:
        'You are a business intelligence agent. When asked about pipeline, you MUST call the get_pipeline_metrics tool. Do not answer from memory.',
      tools: [
        {
          name: 'get_pipeline_metrics',
          description: 'Returns deterministic sales pipeline metrics from the Deals board.',
          parameters: {
            type: 'object',
            properties: { sector: { type: 'string', description: 'Optional sector filter.' } },
          },
        },
      ],
      messages: [{ role: 'user', text: 'How is our pipeline looking?' }],
      maxTokens: 256,
    });

    if (turn.toolCalls.length) {
      const c = turn.toolCalls[0];
      console.log(`  TOOL CALLING WORKS — model called ${c.name}(${JSON.stringify(c.input)})`);
      console.log(`  call id: ${c.id || '(none supplied)'}`);
      if (c.parseError) console.log(`  WARNING: arguments did not parse — ${c.parseError}`);
      return !c.parseError;
    }
    console.log(`  Model replied with text instead of calling the tool:`);
    console.log(`    ${turn.text.join(' ').slice(0, 200)}`);
    console.log(`  Tool calling may be unsupported, or the model chose not to call.`);
    return false;
  } catch (err) {
    console.log(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function main() {
  if (!KEY) {
    console.error('GEMINI_API_KEY is not set in this shell. Set it and re-run.');
    process.exit(1);
  }
  console.log('Querying Google for the models available to this key…\n');

  const [native, compat] = await Promise.all([
    listNative(),
    listCompat().catch((e: Error) => {
      console.log(`  (compat model list unavailable: ${e.message})`);
      return [] as string[];
    }),
  ]);

  const compatSet = new Set(compat);
  const chatModels = native.filter((m) => m.supportedGenerationMethods?.includes('generateContent'));

  const rows = (has('all') ? native : chatModels)
    .map((m) => ({
      id: bare(m.name),
      inTok: m.inputTokenLimit ?? 0,
      outTok: m.outputTokenLimit ?? 0,
      methods: m.supportedGenerationMethods ?? [],
      onCompat: compatSet.size === 0 ? null : compatSet.has(bare(m.name)),
      score: score(bare(m.name)),
    }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  console.log(`Models visible to this key: ${native.length} total, ${chatModels.length} chat-capable\n`);
  console.log(`${'model id'.padEnd(42)} ${'context'.padStart(9)} ${'out'.padStart(7)}  compat  chat`);
  console.log('─'.repeat(80));
  for (const r of rows) {
    const compatMark = r.onCompat === null ? '  ?   ' : r.onCompat ? '  yes ' : '  no  ';
    const chat = r.methods.includes('generateContent') ? 'yes' : 'no';
    console.log(
      `${r.id.padEnd(42)} ${String(r.inTok).padStart(9)} ${String(r.outTok).padStart(7)}  ${compatMark}  ${chat}`,
    );
  }

  // Recommend only among models the compat endpoint will actually accept,
  // since that is the endpoint this adapter calls.
  const eligible = rows.filter(
    (r) => r.score > 0 && r.methods.includes('generateContent') && r.onCompat !== false,
  );

  console.log('\n' + '═'.repeat(80));
  if (!eligible.length) {
    console.log('No suitable chat model found for this key. Share the table above.');
    process.exit(1);
  }

  const best = eligible[0];
  console.log(`RECOMMENDED: ${best.id}`);
  console.log(`  context ${best.inTok.toLocaleString()} in / ${best.outTok.toLocaleString()} out`);
  console.log(`\nSet this in .env.local (or your Vercel env):\n`);
  console.log(`  GEMINI_MODEL=${best.id}`);
  console.log(`\nRunners-up: ${eligible.slice(1, 4).map((r) => r.id).join(', ') || '(none)'}`);

  if (has('verify')) {
    const target = arg('model') ?? best.id;
    const ok = await verify(target);
    console.log(
      ok
        ? `\nConfirmed: GEMINI_MODEL=${target} works with this agent's tool calling.`
        : `\nNot confirmed for ${target}. Try another id from the table with --verify --model <id>.`,
    );
    process.exit(ok ? 0 : 1);
  } else {
    console.log(`\nTo prove tool calling works before changing anything:`);
    console.log(`  npx tsx scripts/list-gemini-models.ts --verify`);
  }
}

main().catch((err) => {
  // Never echo the key, even on failure.
  console.error('\nModel listing failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
