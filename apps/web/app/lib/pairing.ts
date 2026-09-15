import { ApiError, apiPost } from "./api";
import { getVouchflow } from "./vouchflow";

const SUPPORT_ERROR =
  "This device can't set up payments — a platform passkey with PRF is required.";

type ErrorWithCode = Error & { code?: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as ErrorWithCode).code : undefined;
}

export function isPaymentPasskeyUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  if (
    code === "platform_authenticator_unavailable" ||
    code === "prf_unsupported" ||
    code === "credential_not_found"
  ) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return (
    message.includes("prf result") ||
    message.includes("no passkey") ||
    message.includes("not configured")
  );
}

export async function getPairingState(): Promise<{ enrolled: boolean; deviceId: string | null }> {
  try {
    const { enrolled, deviceId } = await getVouchflow().getEnrollmentState();
    return { enrolled, deviceId };
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("not configured")) {
      return { enrolled: false, deviceId: null };
    }
    throw error;
  }
}

/**
 * Claim this browser's enrolled device for the signed-in account. Enrollment
 * goes browser → Vouchflow and never touches our API, so without this call the
 * sessionless approval ceremonies see an assertion from a signer they cannot
 * attribute and refuse it. `deviceId` is the same value the SDK sends as the
 * assertion's `device_token`. Idempotent; safe to call on every signed-in visit.
 *
 * Resolves `true` only when a claim actually landed — which also means this
 * browser holds a live session. A later `mandate_signer_not_authorized` on a
 * browser that DID claim is therefore a wrong-account session, not a missing
 * one, and signing in again cannot fix it.
 */
export async function registerEnrolledDevice(): Promise<boolean> {
  const { enrolled, deviceId } = await getPairingState();
  if (!enrolled || deviceId === null) return false;
  await apiPost("/v1/vouchflow/devices", { device_token: deviceId });
  return true;
}

/**
 * The passkey that signed was never claimed by the account whose approval it
 * answers. Recoverable: a signed-in visit claims this browser's device, so the
 * ceremony pages answer it by sending the human through login and back.
 */
export function isUnlinkedSigningDevice(caught: unknown): boolean {
  return caught instanceof ApiError && caught.message === "mandate_signer_not_authorized";
}

/**
 * This browser holds a session and its device IS claimed, yet the approval was
 * still refused — so the session belongs to some other account than the one
 * that owns this approval, and another trip through login changes nothing.
 */
export const WRONG_ACCOUNT_DEVICE_MESSAGE =
  "This browser's passkey is linked to a different Trusty Squire account than the one " +
  "that owns this approval. Sign in as the owning account at trustysquire.ai/vault to " +
  "link it, then reopen the approval link.";

// The assertion named no signing device at all, so there is nothing for a
// signed-in visit to claim — unlike an unlinked device, signing in cannot help.
const UNVERIFIABLE_DEVICE_MESSAGE =
  "We couldn't verify which device signed this approval, so it was not accepted. " +
  "Nothing was released or changed. Please contact support.";

/** One wording of an approval refusal the human cannot act on, shared by both ceremonies. */
export function approvalErrorMessage(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError && caught.message === "missing_device_token") {
    return UNVERIFIABLE_DEVICE_MESSAGE;
  }
  return caught instanceof Error ? caught.message : fallback;
}

export async function pairDevice(): Promise<void> {
  const client = getVouchflow();

  try {
    const support = await client.checkSupport();
    if (!support.platformAuthenticator) {
      throw new Error(SUPPORT_ERROR);
    }

    const prfSupport = support as typeof support & {
      prf?: boolean;
      prfSupported?: boolean;
    };
    const sdkPrf = prfSupport.prf ?? prfSupport.prfSupported;
    const capabilities =
      sdkPrf === undefined
        ? await window.PublicKeyCredential.getClientCapabilities?.().catch(
            (): PublicKeyCredentialClientCapabilities => ({}),
          )
        : undefined;
    const prfAvailable = sdkPrf ?? capabilities?.["extension:prf"] ?? false;
    if (!prfAvailable) {
      throw new Error(SUPPORT_ERROR);
    }

    // v0.3 requires an option object; this is the SDK's default user handle,
    // also used by getEnrollmentState() and evaluatePrf().
    await client.enroll({ userHandle: "__default__" });
  } catch (error) {
    switch (errorCode(error)) {
      case "platform_authenticator_unavailable":
      case "prf_unsupported":
        throw new Error(SUPPORT_ERROR);
      case "biometric_cancelled":
        throw new Error("Passkey setup was cancelled. Please try again.");
      default:
        throw error;
    }
  }
}
