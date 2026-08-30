import type { AppConfig } from '../config';
import type { LlmProvider } from './provider';
import { AnthropicProvider } from './providers/anthropic';
import { GroqProvider } from './providers/groq';
import { GeminiProvider } from './providers/gemini';

/** Builds the configured vendor adapter. The only place any vendor is named. */
export function createProvider(cfg: AppConfig): LlmProvider {
  switch (cfg.llm.provider) {
    case 'gemini':
      return new GeminiProvider({ apiKey: cfg.llm.apiKey, model: cfg.llm.model });
    case 'groq':
      return new GroqProvider({ apiKey: cfg.llm.apiKey, model: cfg.llm.model });
    case 'anthropic':
      return new AnthropicProvider({ apiKey: cfg.llm.apiKey, model: cfg.llm.model });
  }
}
