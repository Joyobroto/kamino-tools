/** Only label a healthy veto when Kamino itself emitted the error. */
export function isHealthyLiquidationVeto(error: unknown, logs: readonly string[]): boolean {
  const instructionError = (error as { InstructionError?: unknown } | null)?.InstructionError;
  if (!Array.isArray(instructionError)) return false;
  const code = (instructionError[1] as { Custom?: unknown } | null)?.Custom;
  return String(code) === "6016" && logs.some((line) =>
    line.includes("Error Code: ObligationHealthy. Error Number: 6016."));
}
