"use client";

import { useEffect, useRef, useState } from "react";

export interface FieldsResult {
  // The current field map, or null when the input is incomplete/invalid.
  map: Record<string, string> | null;
  // A validation error to surface (duplicate name / named field missing a
  // value). null when merely incomplete (empty) — the parent decides whether
  // that blocks submit.
  error: string | null;
}

function compute(
  multi: boolean,
  single: string,
  rows: { name: string; value: string }[],
): FieldsResult {
  if (multi) {
    const map: Record<string, string> = {};
    for (const r of rows) {
      const n = r.name.trim();
      if (n === "") continue;
      if (r.value === "") {
        return { map: null, error: `Field "${n}" needs a value (use ✕ to delete it).` };
      }
      if (map[n] !== undefined) {
        return { map: null, error: `Duplicate field name "${n}".` };
      }
      map[n] = r.value;
    }
    if (Object.keys(map).length === 0) return { map: null, error: null };
    return { map, error: null };
  }
  if (single === "") return { map: null, error: null };
  return { map: { value: single }, error: null };
}

// The shared credential field editor: a single secret that expands into named
// name/value rows, with a reveal toggle. Used by BOTH /vault/new (API-key mode)
// and the edit modal — one implementation instead of the two that had already
// drifted. Owns its own edit state and reports the current map (+ any active
// validation error) up via onChange.
export function CredentialFields({
  initialFields,
  onChange,
  idPrefix,
  singlePlaceholder = "sk-…",
}: {
  // Prefill (edit). null/undefined → start as an empty single secret. A lone
  // { value } stays single mode; any other map opens multi rows.
  initialFields?: Record<string, string> | null;
  onChange: (r: FieldsResult) => void;
  idPrefix: string;
  singlePlaceholder?: string;
}) {
  const seededMulti =
    initialFields != null &&
    !(Object.keys(initialFields).length === 1 && "value" in initialFields);
  const [multi, setMulti] = useState(seededMulti);
  const [single, setSingle] = useState(
    initialFields != null && Object.keys(initialFields).length === 1 && "value" in initialFields
      ? initialFields.value
      : "",
  );
  const [rows, setRows] = useState<{ name: string; value: string }[]>(
    seededMulti ? Object.entries(initialFields!).map(([name, value]) => ({ name, value })) : [],
  );
  const [reveal, setReveal] = useState(false);

  // Report the computed result up on every change (ref keeps the parent's
  // latest callback without re-subscribing the effect).
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    onChangeRef.current(compute(multi, single, rows));
  }, [multi, single, rows]);

  if (!multi) {
    return (
      <div className="field">
        <label htmlFor={`${idPrefix}-secret`}>Secret</label>
        <input
          id={`${idPrefix}-secret`}
          className="mono"
          type={reveal ? "text" : "password"}
          value={single}
          onChange={(e) => setSingle(e.target.value)}
          placeholder={singlePlaceholder}
          autoComplete="off"
        />
        <div className="field-row-actions">
          <button type="button" className="linkbtn" onClick={() => setReveal((r) => !r)}>
            {reveal ? "hide" : "show"}
          </button>
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              setMulti(true);
              setRows(
                single !== ""
                  ? [{ name: "value", value: single }, { name: "", value: "" }]
                  : [{ name: "", value: "" }],
              );
            }}
          >
            + Add field
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="field">
      <label>Fields</label>
      {rows.map((f, i) => (
        <div className="field-pair" key={i}>
          <input
            className="mono field-name"
            value={f.name}
            placeholder="name"
            autoComplete="off"
            onChange={(e) =>
              setRows((prev) => prev.map((p, j) => (j === i ? { ...p, name: e.target.value } : p)))
            }
          />
          <input
            className="mono"
            type={reveal ? "text" : "password"}
            value={f.value}
            placeholder="value"
            autoComplete="off"
            onChange={(e) =>
              setRows((prev) => prev.map((p, j) => (j === i ? { ...p, value: e.target.value } : p)))
            }
          />
          <button
            type="button"
            className="field-remove"
            aria-label="Remove field"
            onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
          >
            ✕
          </button>
        </div>
      ))}
      <div className="field-row-actions">
        <button type="button" className="linkbtn" onClick={() => setReveal((r) => !r)}>
          {reveal ? "hide values" : "show values"}
        </button>
        <button
          type="button"
          className="linkbtn"
          onClick={() => setRows((prev) => [...prev, { name: "", value: "" }])}
        >
          + Add field
        </button>
      </div>
    </div>
  );
}
