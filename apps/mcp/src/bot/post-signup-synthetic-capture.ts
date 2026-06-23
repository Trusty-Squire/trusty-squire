import type { BrowserState, InteractiveElement } from "./browser.js";
import { credentialFieldNames } from "./credential-extraction-flow.js";
import type { RoundUploader } from "./agent.js";

export interface SyntheticCaptureObservedStep {
  kind: "extract";
  reason: string;
}

export interface SyntheticCaptureEntry {
  service: string;
  round: number;
  oauth: boolean;
  state: BrowserState;
  inventory: InteractiveElement[];
  observed: SyntheticCaptureObservedStep;
  resolved_model?: string;
  resolved_provider?: string;
}

export interface PostSignupSyntheticCapturePort {
  extractCredentials(): Promise<Record<string, string>>;
  getState(): Promise<BrowserState>;
  buildInventory(): Promise<InteractiveElement[]>;
  captureRound(entry: SyntheticCaptureEntry): void;
}

export interface PostSignupSyntheticCaptureInput {
  service: string;
  loopRound: number;
  capturedRound: number;
  oauth: boolean;
  actionKind: string;
  credentials: Record<string, string>;
  steps: string[];
  resolvedModel?: string;
  resolvedProvider?: string;
  roundUploader?: RoundUploader;
  port: PostSignupSyntheticCapturePort;
}

export interface PostSignupSyntheticCaptureResult {
  capturedRound: number;
  haveNewCredentials: boolean;
}

export class PostSignupSyntheticCapture {
  async afterAction(
    input: PostSignupSyntheticCaptureInput,
  ): Promise<PostSignupSyntheticCaptureResult> {
    const credCountBefore = credentialFieldNames(input.credentials).length;
    try {
      const reExtract = await input.port.extractCredentials();
      for (const [key, value] of Object.entries(reExtract)) {
        if (input.credentials[key] === undefined) input.credentials[key] = value;
      }
    } catch {
      // Page may still be navigating from the action; the next round settles.
    }

    const credCountAfter = credentialFieldNames(input.credentials).length;
    const haveNewCredentials = credCountAfter > credCountBefore;
    if (!haveNewCredentials || input.actionKind === "extract") {
      return {
        capturedRound: input.capturedRound,
        haveNewCredentials,
      };
    }

    try {
      const [postState, postInventory] = await Promise.all([
        input.port.getState(),
        input.port.buildInventory(),
      ]);
      const syntheticExtract: SyntheticCaptureObservedStep = {
        kind: "extract",
        reason: `implicit extract after ${input.actionKind} — credentials surfaced on the page`,
      };
      input.port.captureRound({
        service: input.service,
        round: input.capturedRound,
        oauth: input.oauth,
        state: postState,
        inventory: postInventory,
        observed: syntheticExtract,
        ...(input.resolvedModel !== undefined
          ? { resolved_model: input.resolvedModel }
          : {}),
        ...(input.resolvedProvider !== undefined
          ? { resolved_provider: input.resolvedProvider }
          : {}),
      });
      const nextCapturedRound = input.capturedRound + 1;
      if (input.roundUploader !== undefined) {
        void (async () => {
          try {
            await input.roundUploader!({
              service: input.service,
              round: input.loopRound + 1,
              kind: syntheticExtract.kind,
              url: postState.url,
              title: postState.title,
              inventory_count: postInventory.length,
              observed_reason: syntheticExtract.reason,
              html: postState.html,
              ...(postState.screenshot !== undefined &&
              postState.screenshot.length > 0
                ? { screenshot_jpeg_base64: postState.screenshot }
                : {}),
            });
          } catch {
            // best-effort
          }
        })();
      }
      return {
        capturedRound: nextCapturedRound,
        haveNewCredentials,
      };
    } catch {
      // Synthetic capture is auto-promote plumbing, never load-bearing.
      return {
        capturedRound: input.capturedRound,
        haveNewCredentials,
      };
    }
  }
}
