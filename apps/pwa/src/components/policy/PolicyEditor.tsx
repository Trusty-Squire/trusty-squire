"use client";

import { type MandatePolicy, CATEGORY_LABELS, DEFAULT_CATEGORIES, formatCents } from "@/lib/mandate";

interface PolicyEditorProps {
  value: MandatePolicy;
  onChange: (next: MandatePolicy) => void;
}

export function PolicyEditor({ value, onChange }: PolicyEditorProps) {
  function toggleCategory(cat: string): void {
    const has = value.allowed_categories.includes(cat);
    onChange({
      ...value,
      allowed_categories: has
        ? value.allowed_categories.filter((c) => c !== cat)
        : [...value.allowed_categories, cat],
    });
  }

  return (
    <div className="space-y-6">
      <fieldset className="space-y-2">
        <legend className="font-medium">Monthly spend limit</legend>
        <p className="text-sm text-[color:var(--color-ink-soft)]">
          Current: {formatCents(value.spend_limit_cents_per_month)}
        </p>
        <input
          type="range"
          min={1000}
          max={500000}
          step={1000}
          value={value.spend_limit_cents_per_month}
          onChange={(e) =>
            onChange({ ...value, spend_limit_cents_per_month: Number(e.target.value) })
          }
          className="w-full"
          aria-label="Monthly spend limit in cents"
        />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">Allowed service categories</legend>
        <div className="grid grid-cols-2 gap-2">
          {DEFAULT_CATEGORIES.map((cat) => (
            <label key={cat} className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={value.allowed_categories.includes(cat)}
                onChange={() => toggleCategory(cat)}
              />
              <span>{CATEGORY_LABELS[cat] ?? cat}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="font-medium">Silent signup ceiling</legend>
        <p className="text-sm text-[color:var(--color-ink-soft)]">
          Your squire can sign up without asking when the cost is at or under this amount.
        </p>
        <input
          type="number"
          min={0}
          max={10000}
          step={100}
          value={value.silent_signup.max_monthly_cost_cents}
          onChange={(e) =>
            onChange({
              ...value,
              silent_signup: {
                ...value.silent_signup,
                max_monthly_cost_cents: Number(e.target.value),
              },
            })
          }
          className="w-32 px-3 py-2 border border-[color:var(--color-rule)] rounded-lg bg-white"
          aria-label="Silent signup ceiling in cents per month"
        />
        <span className="ml-2 text-sm text-[color:var(--color-ink-soft)]">
          ({formatCents(value.silent_signup.max_monthly_cost_cents)} / month)
        </span>
      </fieldset>
    </div>
  );
}
