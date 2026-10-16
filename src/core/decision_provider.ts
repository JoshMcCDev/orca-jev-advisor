// Multi-provider decisions (odd/tasks/multi-provider.md, P1): who answers a
// System One question set. Jev (TypeSafe) and Cloudflare's Clef speak the
// same contract -- `{model, state, questions}` in, `{model, answers, usage}`
// out -- so a provider is one function with callJev's own signature, minus
// the key, which the provider was built with. A new provider is one new file
// that returns this interface.

import { callJev, type CallJevOptions, type JevResponse, type JsonValue, type Question } from "./jev.ts";

export const PROVIDER_IDS = ["jev", "clef"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface DecisionProvider {
  readonly id: ProviderId;
  /** Same contract, budget and failure classes as callJev (src/core/jev.ts). */
  ask(state: JsonValue, questions: Record<string, Question>, options?: CallJevOptions): Promise<JevResponse>;
}

/** Jev through callJev, unchanged: the same endpoint, headers, body, retry and budget as every caller has today. */
export function createJevProvider(apiKey: string): DecisionProvider {
  return {
    id: "jev",
    ask: (state, questions, options) => callJev(apiKey, state, questions, options),
  };
}
