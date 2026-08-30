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

export interface AppConfig {
  mondayToken: string;
  mondayApiVersion: string;
  dealsBoardId: string;
  workOrdersBoardId: string;
  anthropicApiKey: string;
  anthropicModel: string;
  cacheTtlSeconds: number;
}

function req(name: string, missing: string[]): string {
  const v = process.env[name]?.trim();
  if (!v) {
    missing.push(name);
    return '';
  }
  return v;
}

export function loadConfig(): AppConfig {
  const missing: string[] = [];
  const cfg: AppConfig = {
    mondayToken: req('MONDAY_API_TOKEN', missing),
    mondayApiVersion: process.env.MONDAY_API_VERSION?.trim() || '2024-10',
    dealsBoardId: req('MONDAY_DEALS_BOARD_ID', missing),
    workOrdersBoardId: req('MONDAY_WORK_ORDERS_BOARD_ID', missing),
    anthropicApiKey: req('ANTHROPIC_API_KEY', missing),
    anthropicModel: process.env.ANTHROPIC_MODEL?.trim() || 'claude-sonnet-4-5',
    cacheTtlSeconds: Number(process.env.DATA_CACHE_TTL_SECONDS ?? 300),
  };
  if (missing.length) throw new ConfigError(missing);
  return cfg;
}

/** Non-throwing variant used by the health endpoint to report setup state. */
export function configStatus(): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const k of [
    'MONDAY_API_TOKEN',
    'MONDAY_DEALS_BOARD_ID',
    'MONDAY_WORK_ORDERS_BOARD_ID',
    'ANTHROPIC_API_KEY',
  ]) {
    if (!process.env[k]?.trim()) missing.push(k);
  }
  return { ok: missing.length === 0, missing };
}
