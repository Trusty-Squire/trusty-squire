import type { ObservationFrame } from "./observation-frame.js";
import {
  classifyTerminalGate,
  type TerminalGateKind,
  type TerminalGateVerdict,
} from "./terminal-gate.js";
import {
  credentialFieldNames,
  hasSingleCredentialValue,
  isMultiCredBundle,
} from "./credential-extraction-flow.js";

export type PostSignupTerminalKind = Exclude<TerminalGateKind, "none">;

export interface PostSignupTerminalFailure {
  kind: PostSignupTerminalKind;
  error: string;
  gate: TerminalGateVerdict;
}

export interface PostSignupGateInput {
  service: string;
  frame: ObservationFrame | null;
  fallbackText: string;
  lastDoneReason: string | null;
}

export const DEFAULT_MAX_ROUNDS_AWAITING_MORE_CREDENTIALS = 3;

export interface PostSignupCredentialProgress {
  currentCredentialKeyCount: number;
  roundsSinceLastNewCredential: number;
  inMultiCredMode: boolean;
  haveOnlySeedCredentials: boolean;
}

export interface PostSignupCredentialExit {
  kind: "single_credential" | "stable_multi_credential";
  message: string;
}

// Tracks only post-signup credential progress/exit policy. The caller still
// owns browser reads, extraction tiers, capture writes, and result shaping.
export class PostSignupCredentialTracker {
  private lastCredentialKeyCount: number;
  private roundsSinceLastNewCredential = 0;
  private plannerExtractEmitted = false;
  private pageOffersMultiCred = false;
  private readonly seedHadCredential: boolean;

  constructor(
    initialCredentials: Record<string, string | undefined>,
    private readonly maxRoundsAwaitingMoreCredentials =
      DEFAULT_MAX_ROUNDS_AWAITING_MORE_CREDENTIALS,
  ) {
    this.lastCredentialKeyCount = credentialFieldNames(initialCredentials).length;
    this.seedHadCredential = hasSingleCredentialValue(initialCredentials);
  }

  recordPlannerExtract(): void {
    this.plannerExtractEmitted = true;
  }

  hasObservedMultiCredPage(): boolean {
    return this.pageOffersMultiCred;
  }

  recordPageOffersMultiCred(): boolean {
    if (this.pageOffersMultiCred) return false;
    this.pageOffersMultiCred = true;
    return true;
  }

  observe(
    credentials: Record<string, string | undefined>,
  ): PostSignupCredentialProgress {
    const currentCredentialKeyCount = credentialFieldNames(credentials).length;
    if (currentCredentialKeyCount > this.lastCredentialKeyCount) {
      this.roundsSinceLastNewCredential = 0;
      this.lastCredentialKeyCount = currentCredentialKeyCount;
    } else if (this.lastCredentialKeyCount > 0) {
      this.roundsSinceLastNewCredential += 1;
    }

    const inMultiCredMode =
      isMultiCredBundle(credentials) || this.pageOffersMultiCred;
    const haveOnlySeedCredentials =
      this.seedHadCredential && !this.plannerExtractEmitted;

    return {
      currentCredentialKeyCount,
      roundsSinceLastNewCredential: this.roundsSinceLastNewCredential,
      inMultiCredMode,
      haveOnlySeedCredentials,
    };
  }

  decideEarlyCredentialExit(
    credentials: Record<string, string | undefined>,
    progress: PostSignupCredentialProgress,
    round: number,
  ): PostSignupCredentialExit | null {
    if (
      !progress.inMultiCredMode &&
      hasSingleCredentialValue(credentials) &&
      !progress.haveOnlySeedCredentials
    ) {
      return {
        kind: "single_credential",
        message: `Post-verify: credentials found on round ${round}.`,
      };
    }

    if (
      progress.inMultiCredMode &&
      progress.roundsSinceLastNewCredential >=
        this.maxRoundsAwaitingMoreCredentials &&
      (hasSingleCredentialValue(credentials) || progress.currentCredentialKeyCount >= 2)
    ) {
      const summary = credentialFieldNames(credentials).join(", ");
      return {
        kind: "stable_multi_credential",
        message:
          `Post-verify: multi-cred bundle stable for ${progress.roundsSinceLastNewCredential} ` +
          `rounds — returning what we have (${summary}).`,
      };
    }

    return null;
  }
}

// PostSignupFlow owns navigation/control-flow classification after account
// creation. It does not parse credentials; it decides whether "no credential
// found" is because the service reached a terminal human gate.
export function classifyNoCredentialPostSignup(
  input: PostSignupGateInput,
): {
  gate: TerminalGateVerdict;
  failure: PostSignupTerminalFailure | null;
} {
  const gate = classifyTerminalGate({
    frame: input.frame,
    fallbackText: input.fallbackText,
    lastDoneReason: input.lastDoneReason,
  });

  switch (gate.kind) {
    case "none":
      return { gate, failure: null };
    case "signups_closed":
      return {
        gate,
        failure: {
          kind: gate.kind,
          gate,
          error:
            `signups_closed: ${input.service} is not accepting new self-serve sign-ups ` +
            `(closed / invite-only registration) — no account can be created. Dequeue or sign up manually once open.`,
        },
      };
    case "phone":
      return {
        gate,
        failure: {
          kind: gate.kind,
          gate,
          error:
            `onboarding_blocked: ${input.service}'s API key sits behind a phone/SMS ` +
            `verification wall the bot will not cross — finish the signup manually.`,
        },
      };
    case "payment":
      return {
        gate,
        failure: {
          kind: gate.kind,
          gate,
          error:
            `onboarding_blocked: ${input.service}'s API key sits behind a billing or ` +
            `payment-method wall the bot will not cross — finish the signup manually.`,
        },
      };
    case "account_review":
      return {
        gate,
        failure: {
          kind: gate.kind,
          gate,
          error:
            `onboarding_blocked: ${input.service} put the account into a manual review / ` +
            `waitlist gate after signup — no API key is obtainable until a human approves ` +
            `the account. Finish the signup manually once access is granted.`,
        },
      };
  }
}

export class PostSignupFlow {
  classifyNoCredentialGate(input: PostSignupGateInput): {
    gate: TerminalGateVerdict;
    failure: PostSignupTerminalFailure | null;
  } {
    return classifyNoCredentialPostSignup(input);
  }

  credentialTracker(
    initialCredentials: Record<string, string | undefined>,
  ): PostSignupCredentialTracker {
    return new PostSignupCredentialTracker(initialCredentials);
  }
}
