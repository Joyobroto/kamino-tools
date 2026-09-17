/** Only label a healthy veto when Kamino itself emitted the error. */
export function isHealthyLiquidationVeto(error: unknown, logs: readonly string[]): boolean {
  const instructionError = (error as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(instructionError)) return false;
  const code = (instructionError[1] as { Custom?: unknown } | null)?.Custom;
  return String(code) === "6016" && logs.some((line) =>
    line.includes("Error Code: ObligationHealthy. Error Number: 6016."));
}

/** Codes are scoped to the actual failing program, never matched globally. */
export function isClmmRouteFailure(error: unknown, logs: readonly string[], instructions: readonly { programAddress: string }[]): boolean {
  const ix = (error as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(ix)) return false;
  const code = Number((ix[1] as { Custom?: unknown } | null)?.Custom);
  const program = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
  return [6024, 6035].includes(code) && (
    instructions[Number(ix[0])]?.programAddress === program
    || logs.some((line) => line.startsWith(`Program ${program} failed:`))
  );
}
