/** ponytail: metrics-gated Phase D stays off until five stable sessions after A–C. */
export function isDataAlignmentPhaseDEnabled(nowUtc = new Date().toISOString()): boolean {
  if (process.env.GLITCH_DATA_PHASE_D !== "1") {
    return false;
  }
  const stableAfter = process.env.GLITCH_DATA_PHASE_D_STABLE_AFTER_UTC;
  if (!stableAfter) {
    return false;
  }
  return Date.parse(nowUtc) >= Date.parse(stableAfter);
}
