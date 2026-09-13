import type { CDPSession, ConsoleMessage, Page } from "playwright";
import type { CardValueOutputMask } from "./card-value-output-mask.js";

export interface OperatorNetworkRecord {
  seq: number;
  request_id: string;
  frame_id: string | null;
  target_url: string;
  method: string;
  url: string;
  started_at: number;
  completed_at: number | null;
  state: "pending" | "completed" | "failed";
  status: number | null;
  request_headers: Record<string, string>;
  request_body: string | null;
  response_headers: Record<string, string> | null;
  response_body: string | null;
  loading_failed: {
    error_text: string;
    canceled: boolean;
    blocked_reason: string | null;
    cors_error: string | null;
  } | null;
}

export interface OperatorConsoleRecord {
  seq: number;
  kind: "console" | "exception";
  level: string;
  text: string;
  url: string;
  at: number;
}

export interface OperatorScreenshotRecord {
  seq: number;
  kind: "screenshot";
  url: string;
  frame_url: string | null;
  full_page: boolean;
  at: number;
}

type CdpRequest = {
  requestId: string;
  frameId?: string;
  timestamp: number;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    postData?: string;
  };
};

type CdpResponse = {
  requestId: string;
  response: { status: number; headers?: Record<string, string> };
};

type CdpFailure = {
  requestId: string;
  timestamp: number;
  errorText: string;
  canceled?: boolean;
  blockedReason?: string;
  corsErrorStatus?: { corsError?: string };
};

/** Bounded, session-local evidence stream. It diagnoses nothing. */
export class OperatorEvidenceCollector {
  private sequence = 0;
  private readonly network = new Map<string, OperatorNetworkRecord>();
  private readonly console: OperatorConsoleRecord[] = [];
  private readonly screenshots: OperatorScreenshotRecord[] = [];
  private readonly attachments = new WeakMap<Page, Promise<void>>();
  private readonly sessions = new WeakMap<Page, CDPSession>();

  constructor(private readonly mask: CardValueOutputMask) {}

  private next(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private boundedPush<T>(target: T[], value: T): void {
    target.push(value);
    if (target.length > 500) target.splice(0, target.length - 500);
  }

  attach(page: Page): Promise<void> {
    const existing = this.attachments.get(page);
    if (existing !== undefined) return existing;
    const attaching = this.attachPage(page);
    this.attachments.set(page, attaching);
    return attaching;
  }

  private async attachPage(page: Page): Promise<void> {
    const onConsole = (message: ConsoleMessage): void => {
      this.boundedPush(this.console, {
        seq: this.next(),
        kind: "console",
        level: message.type(),
        text: this.mask.maskText(message.text()),
        url: message.location().url || page.url(),
        at: Date.now(),
      });
    };
    const onPageError = (error: Error): void => {
      this.boundedPush(this.console, {
        seq: this.next(),
        kind: "exception",
        level: "error",
        text: this.mask.maskText(error.message),
        url: page.url(),
        at: Date.now(),
      });
    };
    page.on("console", onConsole);
    page.on("pageerror", onPageError);
    page.once("close", () => {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      void this.sessions
        .get(page)
        ?.detach()
        .catch(() => undefined);
    });

    const cdp = await page.context().newCDPSession(page);
    this.sessions.set(page, cdp);
    await cdp.send("Network.enable", { maxPostDataSize: 65_536 });
    cdp.on("Network.requestWillBeSent", (event: CdpRequest) => {
      const previous = this.network.get(event.requestId);
      const record: OperatorNetworkRecord = {
        seq: this.next(),
        request_id: event.requestId,
        frame_id: event.frameId ?? null,
        target_url: page.url(),
        method: event.request.method,
        url: this.mask.maskText(event.request.url),
        started_at: Math.round(event.timestamp * 1000),
        completed_at: null,
        state: "pending",
        status: null,
        request_headers: this.mask.maskValue(event.request.headers ?? {}),
        request_body:
          event.request.postData === undefined
            ? null
            : this.mask.maskText(event.request.postData, "request_body"),
        response_headers: null,
        response_body: null,
        loading_failed: null,
      };
      if (previous !== undefined && previous.state === "pending") previous.state = "completed";
      this.network.set(event.requestId, record);
      if (this.network.size > 500) this.network.delete(this.network.keys().next().value as string);
    });
    cdp.on("Network.responseReceived", (event: CdpResponse) => {
      const record = this.network.get(event.requestId);
      if (record === undefined) return;
      record.seq = this.next();
      record.status = event.response.status;
      record.response_headers = this.mask.maskValue(event.response.headers ?? {});
    });
    cdp.on("Network.loadingFinished", (event: { requestId: string; timestamp: number }) => {
      const record = this.network.get(event.requestId);
      if (record === undefined) return;
      record.seq = this.next();
      record.state = "completed";
      record.completed_at = Math.round(event.timestamp * 1000);
      void cdp
        .send("Network.getResponseBody", { requestId: event.requestId })
        .then((body) => {
          record.response_body = this.mask.maskText(body.body.slice(0, 65_536), "response_body");
          record.seq = this.next();
        })
        .catch(() => undefined);
    });
    cdp.on("Network.loadingFailed", (event: CdpFailure) => {
      const record = this.network.get(event.requestId);
      if (record === undefined) return;
      record.seq = this.next();
      record.state = "failed";
      record.completed_at = Math.round(event.timestamp * 1000);
      record.loading_failed = {
        error_text: this.mask.maskText(event.errorText),
        canceled: event.canceled === true,
        blocked_reason: event.blockedReason ?? null,
        cors_error: event.corsErrorStatus?.corsError ?? null,
      };
    });
  }

  recordScreenshot(value: Omit<OperatorScreenshotRecord, "seq" | "kind" | "at">): void {
    this.boundedPush(this.screenshots, {
      seq: this.next(),
      kind: "screenshot",
      at: Date.now(),
      ...value,
    });
  }

  read(
    since = 0,
    requestId?: string,
  ): {
    cursor: number;
    network: OperatorNetworkRecord[];
    console: OperatorConsoleRecord[];
    screenshots: OperatorScreenshotRecord[];
  } {
    const network = [...this.network.values()]
      .filter(
        (record) =>
          record.seq > since && (requestId === undefined || record.request_id === requestId),
      )
      .sort((left, right) => left.seq - right.seq)
      .map((record) => this.mask.maskValue(record));
    return {
      cursor: this.sequence,
      network,
      console: this.console
        .filter((record) => record.seq > since && requestId === undefined)
        .map((record) => this.mask.maskValue(record)),
      screenshots: this.screenshots
        .filter((record) => record.seq > since && requestId === undefined)
        .map((record) => this.mask.maskValue(record)),
    };
  }
}
