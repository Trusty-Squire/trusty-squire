// Telegram Bot API client — payment approvals and vault lifecycle alerts.
//
// Missing configuration, transport failure, and a three-second abort return
// false; callers decide whether delivery failure fails their operation.
// Injectable fetch matches the fetchFn
// pattern used elsewhere (npm-downloads.ts) so tests don't hit the network.

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token.length === 0) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false,
      }),
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
