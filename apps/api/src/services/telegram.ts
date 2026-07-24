// Telegram Bot API client — payment-approval push notifications.
//
// Sends are best-effort: an unset bot token or a failed call must never
// break the caller (pay-approval creation, the link webhook), so this
// never throws. Injectable fetch matches the fetchFn pattern used
// elsewhere (npm-downloads.ts) so tests don't hit the network.

export async function sendTelegramMessage(
  chatId: string,
  text: string,
  fetchFn: typeof globalThis.fetch = fetch,
): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (token === undefined || token.length === 0) return false;
  try {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
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
  }
}
