import type { FaqItem } from "../lib/structured-data";

export function FaqSection({
  faqs,
  heading = "Frequently asked questions",
  headingId = "frequently-asked-questions",
}: {
  faqs: readonly FaqItem[];
  heading?: string;
  headingId?: string;
}) {
  return (
    <section className="faq-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{heading}</h2>
      <dl>
        {faqs.map((faq) => (
          <div key={faq.question}>
            <dt>{faq.question}</dt>
            <dd>{faq.answer}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
