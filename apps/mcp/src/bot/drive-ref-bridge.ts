import type { Frame } from "playwright";
import { isCompactV2Handle, type StableObservationRefs } from "./compact-observation-v2.js";
import type { DriveSnapshot } from "./drive-snapshot.js";

type DriveRow = [string, string, string?];
const PRIVATE_DRIVE_REF = /^@e:f\d+d(\d+)$/;
const PRIVATE_DRIVE_REF_IN_TEXT = /@e:f\d+d\d+/g;

/**
 * The drive registry is scoped to a JavaScript document, while its f-number
 * is only a snapshot-time frame ordinal. Frame object ownership plus the
 * document's time origin distinguishes same-URL sibling frames and remounts.
 */
export class DriveRefBridge {
  private readonly frames = new WeakMap<Frame, { origin: string; incarnation: number }>();
  private nextIncarnation = 1;
  private publicByPrivate = new Map<string, string>();

  constructor(private readonly allocator: StableObservationRefs) {}

  reserve(epochDoc: string, parts: readonly { frame: Frame; snapshot: DriveSnapshot }[]): void {
    const current = new Map<string, string>();
    for (const { frame, snapshot } of parts) {
      // documentEpoch is produced in the same evaluate as the controls. Its
      // URL suffix changes during pushState; timeOrigin changes on a new load.
      const delimiter = snapshot.documentEpoch.indexOf("|");
      const origin =
        delimiter < 0 ? snapshot.documentEpoch : snapshot.documentEpoch.slice(0, delimiter);
      let record = this.frames.get(frame);
      if (record === undefined || record.origin !== origin) {
        record = { origin, incarnation: this.nextIncarnation++ };
        this.frames.set(frame, record);
      }
      for (const element of snapshot.elements) {
        const match = PRIVATE_DRIVE_REF.exec(element.ref);
        if (match === null) continue;
        // The d-number is the document's WeakMap node key. Strip the f-number
        // so reordering frames does not rename a surviving node.
        const identity = `drive:${record.incarnation}:d${match[1]}`;
        current.set(element.ref, this.allocator.get(epochDoc, identity));
      }
    }
    this.publicByPrivate = current;
  }

  publicRef(privateRef: string): string | undefined {
    return this.publicByPrivate.get(privateRef);
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
      return [row[2] === undefined ? [ref, row[1]] : [ref, row[1], this.publicText(row[2])]];
    });
  }
}
