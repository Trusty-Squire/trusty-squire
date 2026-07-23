// INTERIM provider. Replace with `@vouchflow/web`'s `evaluatePrf` (identical
// signature) once that package ships the PRF extension, so the
// vouchflow-enrolled passkey is reused instead of a standalone credential.

export async function evaluatePrf(salt: Uint8Array): Promise<Uint8Array> {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: "required",
      extensions: {
        prf: { eval: { first: new Uint8Array(salt) } },
      },
    },
  })) as PublicKeyCredential | null;
  const first = credential?.getClientExtensionResults().prf?.results?.first;
  if (first === undefined) {
    throw new Error("Passkey PRF result is unavailable.");
  }
  return new Uint8Array(first as ArrayBuffer);
}
