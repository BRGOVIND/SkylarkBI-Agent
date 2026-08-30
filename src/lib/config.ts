/**
 * Central runtime configuration. Every secret is read from the server-side
 * environment only — nothing here is ever bundled into client code.
 */

export class ConfigError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `See .env.example for setup instructions.`,
    );
    this.name = 'ConfigError';
    this.missing = missing;
  }
}

export type LlmProviderName = 'anthropic' | 'groq' | 'gemini';

/** Anything env-shaped, so callers and tests can pass a plain object. */
type EnvLike = Record<string, string | undefined>;

export const DEFAULT_MODELS: Record<LlmProviderName, string> = {
  anthropic: 'claude-sonnet-4-5',
  groq: 'openai/gpt-oss-120b',
  gemini: 'gemini-2.5-flash',
};

const KEY_VAR: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
};

const MODEL_VAR: Record<LlmProviderName, string> = {
  anthropic: 'ANTHROPIC_MODEL',
  groq: 'GROQ_MODEL',
  gemini: 'GEMINI_MODEL',
};

export interface AppConfig {
  mondayToken: string;
  mondayApiVersion: string;
  dealsBoardId: string;
  workOrdersBoardId: string;
  llm: { provider: LlmProviderName; apiKey: string; model: string };
  cacheTtlSeconds: number;
}

/**
 * Chooses the LLM vendor. An explicit LLM_PROVIDER always wins; otherwise we
 * infer from whichever key is present, so a deployment that only has a Groq
 * key is not asked for an Anthropic one.
 */
export function resolveProvider(env: EnvLike = process.env): LlmProviderName {
  const explicit = env.LLM_PROVIDER?.trim().toLowerCase();
  if (explicit === 'groq' || explicit === 'anthropic' || explicit === 'gemini') return explicit;
  if (explicit) {
    throw new Error(`LLM_PROVIDER must be "gemini", "groq" or "anthropic" (got "${explicit}").`);
  }
  // Inference order matches the documented preference, so a deployment holding
  // only one key is never asked for another provider's.
  if (env.GEMINI_API_KEY?.trim()) return 'gemini';
  if (env.GROQ_API_KEY?.trim()) return 'groq';
  return 'anthropic';
}

export function modelFor(provider: LlmProviderName, env: EnvLike = process.env): string {
  return env[MODEL_VAR[provider]]?.trim() || DEFAULT_MODELS[provider];
}

/**
 * The label to use when the provider key is absent. Shared by loadConfig and
 * configStatus so both paths tell an operator the same thing.
 */
function providerKeyLabel(env: EnvLike = process.env): string {
  const provider = resolveProvider(env);
  const chosen = !!env.LLM_PROVIDER?.trim();
  const anyKey = (['gemini', 'groq', 'anthropic'] as LlmProviderName[]).some(
    (p) => env[KEY_VAR[p]]?.trim(),
  );
  return chosen || anyKey ? KEY_VAR[provider] : 'LLM_PROVIDER and its matching API key';
}

function req(name: string, missing: string[], label = name): string {
  const v = process.env[name]?.trim();
  if (!v) {
    missing.push(label);
    return '';
  }
  return v;
}

export function loadConfig(): AppConfig {
  const missing: string[] = [];
  const provider = resolveProvider();
  const cfg: AppConfig = {
    mondayToken: req('MONDAY_API_TOKEN', missing),
    mondayApiVersion: process.env.MONDAY_API_VERSION?.trim() || '2024-10',
    dealsBoardId: req('MONDAY_DEALS_BOARD_ID', missing),
    workOrdersBoardId: req('MONDAY_WORK_ORDERS_BOARD_ID', missing),
    llm: {
      provider,
      // Only the selected provider's key is required — and when no provider was
      // chosen and no key of any kind exists, the requirement is reported as a
      // category. Naming ANTHROPIC_API_KEY to an operator who intends to use
      // Gemini sends them to fix the wrong thing. Mirrors configStatus().
      apiKey: req(KEY_VAR[provider], missing, providerKeyLabel()),
      model: modelFor(provider),
    },
    cacheTtlSeconds: Number(process.env.DATA_CACHE_TTL_SECONDS ?? 300),
  };
  if (missing.length) throw new ConfigError(missing);
  return cfg;
}

/**
 * Non-throwing variant used by the health endpoint to report setup state.
 *
 * The provider requirement is conditional: only the SELECTED provider's key is
 * ever reported missing. When no provider is selected and no key of any kind is
 * present, the requirement is reported as a category rather than naming one
 * vendor's variable — telling an operator who intends to use Gemini that
 * ANTHROPIC_API_KEY is missing is actively misleading.
 */
export function configStatus(): {
  ok: boolean;
  missing: string[];
  provider: LlmProviderName | null;
  model: string | null;
} {
  const missing: string[] = [];
  let provider: LlmProviderName | null = null;
  try {
    provider = resolveProvider();
  } catch {
    return {
      ok: false,
      missing: ['LLM_PROVIDER (must be "gemini", "groq" or "anthropic")'],
      provider: null,
      model: null,
    };
  }
  for (const k of ['MONDAY_API_TOKEN', 'MONDAY_DEALS_BOARD_ID', 'MONDAY_WORK_ORDERS_BOARD_ID']) {
    if (!process.env[k]?.trim()) missing.push(k);
  }

  if (!process.env[KEY_VAR[provider]]?.trim()) missing.push(providerKeyLabel());

  return { ok: missing.length === 0, missing, provider, model: modelFor(provider) };
}
