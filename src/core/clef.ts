// Multi-provider decisions (odd/tasks/multi-provider.md, P2): Cloudflare's
// Clef as a System One provider.
//
// Measured live on 2026-10-16 (51 real gate commands, fixtures/clef):
//   - `POST https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/{model}`
//     with `Authorization: Bearer {token}` and `{model, state, questions}`.
//   - The answer arrives wrapped: `{result: {model, answers, usage}, success, errors, messages}`.
//   - Named noul criteria are refused (HTTP 422, code 3030, "Extra inputs are
//     not permitted"); only `criteria: {true?, false?}` is accepted, so named
//     criteria become one `true` criterion that names them all.
//   - Limits: 1-64 questions, 2-255 choice options, 2-10 score levels.
//   - Billing: neurons per million INPUT tokens (output is free).
//   - HTTP 429 code 3036 is the daily free allocation (10,000 neurons, reset
//     at 00:00 UTC); 3040 is capacity, a per-moment limit. Both from
//     Cloudflare's documented error table; a bare 429 counts as a rate limit.
//
// The token is always a parameter: this module reads no environment or file
// and never puts the token or the account id in a thrown error.

import { isRecord } from "../guards.ts";
import { jevFailureOf, JevRequestError, postSystemOne, type CallJevOptions, type JevFailure, type JevResponse, type JevUsage, type JsonValue, type Question } from "./jev.ts";
import type { DecisionProvider } from "./decision_provider.ts";

export const CLEF_MODELS = ["clef", "clef-flash", "clef-omni"] as const;
export type ClefModel = (typeof CLEF_MODELS)[number];
export const DEFAULT_CLEF_MODEL: ClefModel = "clef";

export function isClefModel(value: unknown): value is ClefModel {
  return typeof value === "string" && (CLEF_MODELS as readonly string[]).includes(value);
}

/** Neurons per million input tokens, from Cloudflare's model pages (2026-10-16). */
export const NEURONS_PER_MILLION_INPUT: Readonly<Record<ClefModel, number>> = { clef: 21_818, "clef-omni": 13_636, "clef-flash": 3_455 };

export const CLEF_MAX_QUESTIONS = 64;
const MIN_OPTIONS = 2;
const MAX_CHOICE_OPTIONS = 255;
const MAX_SCORE_LEVELS = 10;

/** Cloudflare's error code for "You have used up your daily free allocation of 10,000 neurons." */
const DAILY_ALLOWANCE_CODE = 3036;

export function clefUrl(accountId: string, model: ClefModel): string {
  return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/@cf/cloudflare/${model}`;
}

/** What one call costs against the daily allowance. */
export function neuronsFor(model: ClefModel, usage: JevUsage): number {
  return (usage.input_tokens * NEURONS_PER_MILLION_INPUT[model]) / 1_000_000;
}

/**
 * The question set as Clef accepts it, or null when it is outside Clef's
 * limits (the caller asks Jev instead, recorded as `unsupported`).
 */
export function toClefQuestions(questions: Record<string, Question>): Record<string, Question> | null {
  const entries = Object.entries(questions);
  if (entries.length > CLEF_MAX_QUESTIONS) return null;
  const mapped: Record<string, Question> = {};
  for (const [id, question] of entries) {
    if (question.type === "choice") {
      const options = Object.keys(question.criteria).length;
      if (options < MIN_OPTIONS || options > MAX_CHOICE_OPTIONS) return null;
      mapped[id] = question;
    } else if (question.type === "score") {
      if (question.criteria.length < MIN_OPTIONS || question.criteria.length > MAX_SCORE_LEVELS) return null;
      mapped[id] = question;
    } else {
      const criteria = question.criteria;
      const named = criteria !== undefined && Object.keys(criteria).some((key) => key !== "true" && key !== "false");
      mapped[id] = named ? { ...question, criteria: { true: `Yes when all of these hold: ${Object.values(criteria).join(" ")}` } } : question;
    }
  }
  return mapped;
}

/**
 * Why a Clef call failed. The System One classes (src/core/jev.ts) plus the
 * three a cascade treats differently:
 *   auth            -- 401/403: the token or account is wrong. Escalates.
 *   rate-limit      -- a 429 that is not the daily allowance. Escalates this call only.
 *   daily-allowance -- 429 code 3036. Clef is skipped until 00:00 UTC.
 *   unsupported     -- the question set is outside Clef's limits; never sent.
 */
export type ClefFailure =
  | Exclude<JevFailure, { readonly kind: "overload" }>
  | { readonly kind: "auth"; readonly status: number }
  | { readonly kind: "rate-limit"; readonly status: number }
  | { readonly kind: "daily-allowance" }
  | { readonly kind: "unsupported" };

export class ClefError extends Error {
  readonly failure: ClefFailure;
  constructor(message: string, failure: ClefFailure) {
    super(message);
    this.name = "ClefError";
    this.failure = failure;
  }
}

/** The class of a failure thrown by a Clef provider, or null for any other error. */
export function clefFailureOf(error: unknown): ClefFailure | null {
  return error instanceof ClefError ? error.failure : null;
}

function errorCodes(body: string): number[] {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed) || !Array.isArray(parsed.errors)) return [];
    return parsed.errors.flatMap((entry: unknown) => (isRecord(entry) && typeof entry.code === "number" ? [entry.code] : []));
  } catch {
    return [];
  }
}

function classify(error: unknown): ClefFailure | null {
  const failure = jevFailureOf(error);
  if (failure === null) return null;
  if (failure.kind === "overload" || (failure.kind === "http4xx" && failure.status === 429)) {
    const body = error instanceof JevRequestError ? error.responseBody : "";
    return errorCodes(body).includes(DAILY_ALLOWANCE_CODE) ? { kind: "daily-allowance" } : { kind: "rate-limit", status: failure.status };
  }
  if (failure.kind === "http4xx" && (failure.status === 401 || failure.status === 403)) return { kind: "auth", status: failure.status };
  return failure;
}

function unwrapEnvelope(parsed: unknown): unknown {
  return isRecord(parsed) && "result" in parsed ? parsed.result : parsed;
}

export interface ClefCredentials {
  readonly accountId: string;
  readonly token: string;
}

export interface ClefProvider extends DecisionProvider {
  readonly id: "clef";
  readonly model: ClefModel;
}

export function createClefProvider(config: ClefCredentials & { readonly model: ClefModel }): ClefProvider {
  const { accountId, token, model } = config;
  return {
    id: "clef",
    model,
    async ask(state: JsonValue, questions: Record<string, Question>, options?: CallJevOptions): Promise<JevResponse> {
      const mapped = toClefQuestions(questions);
      if (mapped === null) throw new ClefError("Clef: the question set is outside Clef's limits", { kind: "unsupported" });
      try {
        // No retry: in a cascade the next provider is the retry, and a Clef-only gate fails open like a Jev one.
        return await postSystemOne({ name: "Clef", url: clefUrl(accountId, model), token, unwrap: unwrapEnvelope, maxRetries: 0 }, { model, state, questions: mapped }, options);
      } catch (error) {
        const failure = classify(error);
        if (failure === null) throw error;
        // The transport's message names neither the token nor the account; the URL is never part of it.
        throw new ClefError(error instanceof Error ? error.message : String(error), failure);
      }
    },
  };
}
