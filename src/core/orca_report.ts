// ---------------------------------------------------------------------------
// Jev's state reported to Orca from a pane the game does not draw (JEVADV-106,
// odd/tasks/orca-member-report.md). Orca stores a report from any pane: the
// Orca CLI's `game state --json` with env ORCA_GAME_ADVISOR=<json>, kept for
// the caller's terminal; JSON `null` says Jev stopped. Contract v1 is
// `{version, model, effort, pinned}`; the v2 keys are extras beside it and
// never change what a v1 key means. Pure: the hooks module reads the env and
// runs the process.
// ---------------------------------------------------------------------------

import type { OrcaPins } from "./orca_pins.ts";

/** The executable Orca's own env names, or null: a bare name (`orca` is the GNOME screen reader on Linux) is never run. */
export function orcaReportExecutable(gameCli: string | null | undefined, cliCommand: string | null | undefined): string | null {
  for (const raw of [gameCli, cliCommand]) {
    const value = raw?.trim();
    if (value !== undefined && isAbsolutePath(value)) return value;
  }
  return null;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** The launch pins as Orca reports them: only a value of exactly `1`, game pane or not. */
export function orcaReportPins(model: string | null | undefined, effort: string | null | undefined): OrcaPins {
  return { model: model === "1", effort: effort === "1" };
}

export interface OrcaReportInput {
  /** The model as a person reads it (`Haiku 5.5`); null before the router saw one. */
  readonly model: string | null;
  readonly effort: string | null;
  readonly pins: OrcaPins;
  /** The status line Jev draws (`jev · …`). */
  readonly line: string | null;
  /** The skill and the tool Jev picked for the last prompt, by name. */
  readonly skill: string | null;
  readonly tool: string | null;
  /** The model the router sent the loop to, and the one the session itself runs. */
  readonly routedModel: string | null;
  readonly sessionModel: string | null;
  /** Jev's confidence in its last pick (0 to 1); null when Jev judged nothing. */
  readonly confidence: number | null;
  /** Why the router kept the model it had (`same`, `held-by-guard`, ...); null when it changed or nothing held. */
  readonly hold: string | null;
}

/** The v1 report; a v2 key is there only when it has a value. */
export interface OrcaReport {
  readonly version: 1;
  readonly model: string | null;
  readonly effort: string | null;
  readonly pinned: OrcaPins;
  readonly line?: string;
  readonly skill?: string;
  readonly tool?: string;
  readonly routedModel?: string;
  readonly sessionModel?: string;
  readonly confidence?: number;
  readonly hold?: string;
}

export function buildOrcaReport(input: OrcaReportInput): OrcaReport {
  return {
    version: 1,
    model: input.model,
    effort: input.effort,
    pinned: { model: input.pins.model, effort: input.pins.effort },
    ...(input.line === null ? {} : { line: input.line }),
    ...(input.skill === null ? {} : { skill: input.skill }),
    ...(input.tool === null ? {} : { tool: input.tool }),
    ...(input.routedModel === null ? {} : { routedModel: input.routedModel }),
    ...(input.sessionModel === null ? {} : { sessionModel: input.sessionModel }),
    ...(input.confidence === null ? {} : { confidence: input.confidence }),
    ...(input.hold === null ? {} : { hold: input.hold }),
  };
}
