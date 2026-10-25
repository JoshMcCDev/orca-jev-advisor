/** Codex's hook protocol. Keep policy decisions in the existing gate. */
export function codexGateOutput(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  const result = value as Record<string, unknown>;
  const specific = result.hookSpecificOutput;
  const output: Record<string, unknown> = {};
  if (typeof result.systemMessage === "string") output.systemMessage = result.systemMessage;
  if (typeof specific === "object" && specific !== null) {
    const decision = specific as Record<string, unknown>;
    // Codex currently rejects PreToolUse "ask" and then runs the tool.
    // Preserve a policy stop by denying; never silently downgrade it.
    if (decision.permissionDecision === "deny" || decision.permissionDecision === "ask") {
      output.hookSpecificOutput = {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: String(decision.permissionDecisionReason ?? "Stopped by Jev Advisor.") +
          (decision.permissionDecision === "ask" ? " This policy requires human approval. Codex cannot request it through PreToolUse; ask the person to handle this action." : ""),
      };
    }
    // A gate pass leaves Codex's own approval flow in charge.
  }
  return Object.keys(output).length === 0 ? null : output;
}

/** Both sides of a move matter: a patch may overwrite a protected target. */
export function codexPatchPaths(command: string): readonly string[] {
  const paths: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (match?.[1]) paths.push(match[1]);
  }
  return [...new Set(paths)];
}
