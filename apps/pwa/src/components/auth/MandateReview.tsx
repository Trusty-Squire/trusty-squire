import { type MandatePolicy, CATEGORY_LABELS, formatCents, formatExpiry } from "@/lib/mandate";

interface MandateReviewProps {
  policy: MandatePolicy;
  expiresAt: Date;
}

export function MandateReview({ policy, expiresAt }: MandateReviewProps) {
  const ceiling = formatCents(policy.silent_signup.max_monthly_cost_cents);
  return (
    <div className="space-y-4 font-mono text-sm text-[color:var(--color-amber-black)]">
      <p>You are giving your squire authority to:</p>

      <div className="pl-4 space-y-2">
        <p>
          Spend up to <strong>{formatCents(policy.spend_limit_cents_per_month)}</strong> per month
          on your behalf
        </p>
        <p>Across these service categories:</p>
        <ul className="pl-4 list-disc">
          {policy.allowed_categories.map((cat) => (
            <li key={cat}>{CATEGORY_LABELS[cat] ?? cat}</li>
          ))}
        </ul>

        <p className="pt-2">Without asking, for actions:</p>
        <ul className="pl-4 list-disc">
          {policy.silent_signup.allow_free ? <li>Free signups in allowed categories</li> : null}
          <li>Paid signups under {ceiling}/month for services you've used before</li>
        </ul>

        <p className="pt-2">Always asking, for:</p>
        <ul className="pl-4 list-disc">
          <li>Any new service you haven't used before</li>
          <li>Any signup over {ceiling}/month</li>
          <li>Cancellations and credential rotations</li>
        </ul>
      </div>

      <p className="pt-2">
        This authorization is valid for 1 year (until {formatExpiry(expiresAt)}) and can be edited
        any time.
      </p>
    </div>
  );
}
