import type { AppConfig } from '../config';
import type { LlmProvider } from './provider';
import { AnthropicProvider } from './providers/anthropic';
import { GroqProvider } from './providers/groq';

/** Builds the configured vendor adapter. The only place either is named. */
export function createProvider(cfg: AppConfig): LlmProvider {
  switch (cfg.llm.provider) {
    case 'groq':
      return new GroqProvider({ apiKey: cfg.llm.apiKey, model: cfg.llm.model });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: cfg.llm.apiKey, model: cfg.llm.model });
  }
}
