import { getVouchflow } from "./vouchflow";

export async function evaluatePrf(salt: Uint8Array): Promise<Uint8Array> {
  return getVouchflow().evaluatePrf({ salt });
}
