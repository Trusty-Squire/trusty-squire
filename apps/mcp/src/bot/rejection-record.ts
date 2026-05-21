// rejection-record.ts — write structured rejection records to
// `corpus/skills-failed/<id>/rejection.json` (T9 / D2).
//
// The synthesizer (promote-to-skill.ts) returns structured rejections;
// the CLI persists them so an operator can triage what went wrong
// without staring at promoter exit codes. Each failed promote produces
// one directory containing:
//
//   rejection.json — the rejection itself, parseable
//   captures/      — copies of the offending capture files (when
//                    available; an unreadable directory rejection
//                    has no captures to copy)
//
// Inputs and outputs are both filesystem-level so this module is
// thin glue, not load-bearing logic. The synthesizer remains a pure
// function; nothing here imports it directly.

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PromoteRejection } from "./promote-to-skill.js";

export interface WriteRejectionInput {
  /** The structured rejection from the synthesizer. */
  rejection: PromoteRejection;
  /** Where the original captures lived. Used to copy them as evidence. */
  captureDir: string;
  /** Canonical service slug. */
  service: string;
  /** Which run produced this rejection. */
  runId: string;
  /**
   * Root of the `corpus/skills-failed/` directory. Default:
   * `~/.trusty-squire/corpus/skills-failed/`. Override for tests or
   * non-standard installs.
   */
  failedRoot: string;
  /** Wall-clock for the rejection's `rejected_at` timestamp. */
  now: Date;
}

export interface WriteRejectionResult {
  /** Absolute path to the rejection directory. */
  rejectionDir: string;
  /** Absolute path to the rejection.json file. */
  rejectionFile: string;
  /** Absolute path to the captures/ subdirectory (may be empty). */
  capturesDir: string;
  /** Number of capture files copied as evidence. */
  capturesCopied: number;
}

/**
 * The shape written to rejection.json. Strictly serialisable —
 * everything in the file is a string, number, or null. Schema for
 * parsing this back lives in the same place as the writer (here)
 * so changes are colocated.
 *
 * Versioned (rejection_format_version) so future CLI commands can
 * detect older rejection files and offer migration instead of failing
 * silently.
 */
export interface RejectionFile {
  rejection_format_version: 1;
  rejected_at: string;
  service: string;
  run_id: string;
  stage: PromoteRejection["stage"];
  error_kind: PromoteRejection["error_kind"];
  message: string;
  offending_round: number | null;
  offending_step: number | null;
  detail: string | null;
  synthesizer_version: number;
  capture_evidence: {
    /** Number of capture files preserved alongside this rejection. */
    rounds_copied: number;
    /** Filename prefix used when looking up captures (`<slug>-<runId>`). */
    capture_prefix: string;
  };
}

/**
 * Persist a synthesizer rejection to disk. Creates the rejection
 * directory under `failedRoot`, writes `rejection.json`, and copies
 * any matching capture files into `captures/` as evidence.
 *
 * Returns paths so the CLI can echo them. Throws only on real I/O
 * failures (parent dir unwritable, disk full); a missing capture
 * directory is logged inside the rejection record itself rather than
 * blocking the write.
 */
export function writeRejection(input: WriteRejectionInput): WriteRejectionResult {
  const { rejection, captureDir, service, runId, failedRoot, now } = input;

  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const rejectionId = `${slug}-${runId}-${now.getTime().toString(36)}`;
  const rejectionDir = join(failedRoot, rejectionId);
  const capturesDir = join(rejectionDir, "captures");
  const rejectionFile = join(rejectionDir, "rejection.json");

  mkdirSync(capturesDir, { recursive: true });

  // Copy captures as evidence. Best-effort: if the capture dir is
  // unreadable (already gone, permissions, etc.) we skip the copy and
  // record 0 rounds. The rejection itself is still useful — it
  // carries the synthesizer's own analysis of what went wrong.
  let capturesCopied = 0;
  const prefix = `${slug}-${runId}-r`;
  try {
    if (existsSync(captureDir)) {
      const files = readdirSync(captureDir).filter(
        (f) => f.startsWith(prefix) && f.endsWith(".json"),
      );
      for (const file of files) {
        copyFileSync(join(captureDir, file), join(capturesDir, file));
        capturesCopied += 1;
      }
    }
  } catch {
    // Swallow — capture copy is evidence, not load-bearing. The
    // rejection record gets written either way.
  }

  const payload: RejectionFile = {
    rejection_format_version: 1,
    rejected_at: now.toISOString(),
    service,
    run_id: runId,
    stage: rejection.stage,
    error_kind: rejection.error_kind,
    message: rejection.message,
    offending_round: rejection.offending_round ?? null,
    offending_step: rejection.offending_step ?? null,
    detail: rejection.detail ?? null,
    synthesizer_version: rejection.synthesizer_version,
    capture_evidence: {
      rounds_copied: capturesCopied,
      capture_prefix: prefix,
    },
  };

  writeFileSync(rejectionFile, JSON.stringify(payload, null, 2));

  return { rejectionDir, rejectionFile, capturesDir, capturesCopied };
}
