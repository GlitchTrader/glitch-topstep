/**
 * Catchable local-disk failures (TS-REAUDIT-10). ENOSPC and SQLITE_FULL are the same
 * class: the volume or page budget cannot take another write. SQLITE_CORRUPT / malformed
 * headers are the other class. Neither must take down the process uncaught.
 */
export function isCatchableDiskFault(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  if (code === "ENOSPC") {
    return true;
  }
  const detail = `${error.message} ${(error as { errstr?: string }).errstr ?? ""} ${code ?? ""}`;
  return /ENOSPC|SQLITE_FULL|SQLITE_CORRUPT|disk is full|not a database|malformed|database disk image/i.test(
    detail,
  );
}
