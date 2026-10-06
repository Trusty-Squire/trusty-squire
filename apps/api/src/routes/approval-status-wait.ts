/** A bounded, non-consuming status read for approvals awaiting a human decision. */
export async function waitForApprovalStatus<T extends { status: string; expiresAt: Date }>(
  read: () => Promise<T | null>,
  now: () => Date,
  waitRequested: boolean,
  requestedWaitMs: string | undefined,
): Promise<T | null> {
  const maxWaitMs = 15_000;
  const parsedWaitMs = requestedWaitMs === undefined ? maxWaitMs : Number(requestedWaitMs);
  const waitMs =
    waitRequested && Number.isFinite(parsedWaitMs)
      ? Math.min(Math.max(Math.floor(parsedWaitMs), 0), maxWaitMs)
      : waitRequested
        ? maxWaitMs
        : 0;
  const deadline = Date.now() + waitMs;
  while (true) {
    const record = await read();
    if (record === null || record.status !== "pending" || record.expiresAt <= now()) return record;
    const remainingMs = Math.min(
      deadline - Date.now(),
      record.expiresAt.getTime() - now().getTime(),
    );
    if (remainingMs <= 0) return record;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, remainingMs)));
  }
}
