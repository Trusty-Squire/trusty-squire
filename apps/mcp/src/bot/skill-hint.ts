// Login guidance for the start observation. It is composed before the page is
// seen and ordinary starts never probe Google identity, so it names no
// provider and hedges on whatever the page turns out to offer.

export function loginSessionGuidance(): string {
  return (
    `- login: use whichever method the page offers (Google / GitHub / Microsoft / ` +
    `email). The account may already exist — log IN, don't re-sign-up.\n` +
    `- goal: for a known multi-step goal, start with operate_drive(url, goal, facts); ` +
    `use operate_start when you want to inspect the first page. This session is ` +
    `already open: call operate_drive(session_id, goal, facts) here, then resume ` +
    `the same session with answer and/or added facts if drive hands back.`
  );
}
