import type { Frame } from "playwright";
import { isCompactV2Handle, type StableObservationRefs } from "./compact-observation-v2.js";
import type { DriveSnapshot } from "./drive-snapshot.js";
import type { ActControlIdentity } from "./act/identity.js";

export type DriveRefAnchor = {
  kind: "drive";
  privateRef: string;
  frame: Frame;
  documentTimeOrigin: string;
  identity: ActControlIdentity;
};

type DriveRow = [string, string, string?];
const PRIVATE_DRIVE_REF = /^@e:f\d+d(\d+)$/;
const PRIVATE_DRIVE_REF_IN_TEXT = /@e:f\d+d\d+/g;

/**
 * The drive registry is scoped to a JavaScript document, while its f-number
 * is only a snapshot-time frame ordinal. Frame object ownership plus the
 * document's time origin distinguishes same-URL sibling frames and remounts.
 */
export class DriveRefBridge {
  private readonly frames = new WeakMap<
    Frame,
    { documentTimeOrigin: string; incarnation: number }
  >();
  private nextIncarnation = 1;
  private publicByPrivate = new Map<string, string>();
  private labels = new Map<string, string>();
  private locations = new Map<string, Omit<DriveRefAnchor, "kind" | "identity">>();

  constructor(private readonly allocator: StableObservationRefs) {}

  reserve(epochDoc: string, parts: readonly { frame: Frame; snapshot: DriveSnapshot }[]): void {
    const current = new Map<string, string>();
    const locations = new Map<string, Omit<DriveRefAnchor, "kind" | "identity">>();
    for (const { frame, snapshot } of parts) {
      // documentEpoch is produced in the same evaluate as the controls. Its
      // URL suffix changes during pushState; timeOrigin changes on a new load.
      const delimiter = snapshot.documentEpoch.indexOf("|");
      const documentTimeOrigin =
        delimiter < 0 ? snapshot.documentEpoch : snapshot.documentEpoch.slice(0, delimiter);
      let record = this.frames.get(frame);
      if (record === undefined || record.documentTimeOrigin !== documentTimeOrigin) {
        record = { documentTimeOrigin, incarnation: this.nextIncarnation++ };
        this.frames.set(frame, record);
      }
      for (const element of snapshot.elements) {
        const match = PRIVATE_DRIVE_REF.exec(element.ref);
        if (match === null) continue;
        // The d-number is the document's WeakMap node key. Strip the f-number
        // so reordering frames does not rename a surviving node.
        const identity = `drive:${record.incarnation}:d${match[1]}`;
        current.set(element.ref, this.allocator.get(epochDoc, identity));
        locations.set(element.ref, { privateRef: element.ref, frame, documentTimeOrigin });
      }
    }
    this.publicByPrivate = current;
    this.locations = locations;
  }

  anchors(identities: ReadonlyMap<string, ActControlIdentity>): Map<string, DriveRefAnchor> {
    const anchors = new Map<string, DriveRefAnchor>();
    for (const [privateRef, location] of this.locations) {
      const identity = identities.get(privateRef);
      const handle = this.publicByPrivate.get(privateRef);
      if (
        handle === undefined ||
        identity === undefined ||
        identity.selector.length === 0 ||
        identity.role.length === 0 ||
        location.documentTimeOrigin.length === 0
      )
        continue;
      anchors.set(handle, { kind: "drive", ...location, identity });
    }
    return anchors;
  }

  publicRef(privateRef: string): string | undefined {
    return this.publicByPrivate.get(privateRef);
  }

  setLabels(labels: ReadonlyMap<string, string>): void {
    this.labels = new Map(labels);
  }

  publicText(value: string): string {
    return value.replace(
      PRIVATE_DRIVE_REF_IN_TEXT,
      (ref) => this.publicByPrivate.get(ref) ?? "[stale control]",
    );
  }

  /** Project masked internal rows at the model-facing boundary. */
  publicRows(rows: readonly DriveRow[]): DriveRow[] {
    return rows.flatMap((row) => {
      const privateRef = PRIVATE_DRIVE_REF.test(row[0]);
      const ref = privateRef ? this.publicByPrivate.get(row[0]) : row[0];
      if (ref === undefined || (privateRef && !isCompactV2Handle(ref))) return [];
      const facts = row[2];
      const label = this.labels.get(ref);
      if (facts === undefined) return [label === undefined ? [ref, row[1]] : [ref, row[1], label]];
      const parts = facts.split("|");
      if (label !== undefined && !parts[0]?.includes("=")) parts[0] = label;
      else if (label !== undefined) parts.unshift(label);
      return [[ref, row[1], this.publicText(parts.join("|"))]];
    });
  }
}
