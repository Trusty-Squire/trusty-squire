// Login guidance for the start observation. It is composed before the page is
// seen and ordinary starts never probe Google identity, so it names no
// provider and hedges on whatever the page turns out to offer.

export function loginSessionGuidance(): string {
  return (
    `- login: use whichever method the page offers (Google / GitHub / Microsoft / ` +
    `email). The account may already exist — log IN, don't re-sign-up.\n` +
    `- goal: for a signup or checkout goal, call operate_drive with the goal and ` +
    `facts rather than driving each click/type yourself; resume the same session ` +
    `with answer and/or added facts if it hands back.`
  );
}
