import type { ApprovalWire } from "../src/approval.js";

export const APPROVAL_WIRE: ApprovalWire = {
  id: "01JD000000000000000000PAY1",
  kind: "credential_mutation",
  action: "delete",
  title: "Delete key: github / default",
  details: [
    { label: "Key", value: "github / default" },
    { label: "Effect", value: "The key is deleted from the vault." },
    { label: "Requested by", value: "Ruby" },
  ],
  status: "pending",
  requested_by: "Ruby",
  reason: null,
  created_at: "2026-10-27T12:00:00.000Z",
  expires_at: "2026-10-27T12:10:00.000Z",
  approve_url: "https://trustysquire.ai/vault/mutate/01JD000000000000000000PAY1",
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export function recordingFetch(
  respond: (call: RecordedCall) => Response,
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: RecordedCall = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}
