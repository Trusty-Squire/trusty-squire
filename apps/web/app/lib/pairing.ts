import { getVouchflow } from "./vouchflow";

const SUPPORT_ERROR =
  "This device can't set up payments — a platform passkey with PRF is required.";

type ErrorWithCode = Error & { code?: string };

function errorCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as ErrorWithCode).code : undefined;
}

export async function getPairingState(): Promise<{ enrolled: boolean }> {
  try {
    const { enrolled } = await getVouchflow().getEnrollmentState();
    return { enrolled };
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("not configured")) {
      return { enrolled: false };
    }
    throw error;
  }
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
