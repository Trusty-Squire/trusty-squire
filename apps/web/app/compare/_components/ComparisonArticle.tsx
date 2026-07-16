import Link from "next/link";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { FaqSection } from "../../components/FaqSection";
import { JsonLd } from "../../components/JsonLd";
import { MarketingFooter, MarketingNav } from "../../components/MarketingChrome";
import { articleJsonLd, breadcrumbJsonLd, faqPageJsonLd } from "../../lib/structured-data";
import type { ComparisonContent } from "../content";
import styles from "./comparison-article.module.css";

const VERIFIED = "2026-07-15";

export function ComparisonArticle({ comparison }: { comparison: ComparisonContent }) {
  const path = `/compare/${comparison.slug}`;
  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Compare", path: "/compare" },
    { name: comparison.shortTitle, path },
  ];

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs)} />
      <JsonLd data={faqPageJsonLd(comparison.faqs)} />
      <JsonLd
        data={articleJsonLd({
          title: comparison.title,
          description: comparison.description,
          path,
          datePublished: VERIFIED,
          dateModified: VERIFIED,
        })}
      />
      <MarketingNav />
      <main>
        <article className="discovery">
          <Breadcrumbs items={breadcrumbs} />
          <header className="discovery-head">
            <p className="discovery-kicker">Comparison / {comparison.eyebrow}</p>
            <h1>{comparison.title}</h1>
            <p className="discovery-deck">{comparison.description}</p>
          </header>

          <section className="discovery-section" aria-labelledby="comparison-answer">
            <div className="discovery-label">
              <span>01</span>
              <h2 id="comparison-answer">Short answer</h2>
            </div>
            <div className={styles.answer}>
              {comparison.answer.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </section>

          <section className="discovery-section" aria-labelledby="scope-table">
            <div className="discovery-label">
              <span>02</span>
              <h2 id="scope-table">Scope comparison</h2>
            </div>
            <div className={styles.tableArea}>
              <div
                className={styles.tableWrap}
                tabIndex={0}
                role="region"
                aria-label={comparison.tableCaption}
              >
                <table>
                  <caption>{comparison.tableCaption}</caption>
                  <thead>
                    <tr>
                      {comparison.columns.map((column) => (
                        <th key={column} scope="col">
                          {column}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {comparison.rows.map((row) => (
                      <tr key={row.criterion}>
                        <th scope="row">{row.criterion}</th>
                        {row.values.map((value, index) => (
                          <td key={`${row.criterion}-${comparison.columns[index + 1]}`}>{value}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className={styles.scopeNote}>{comparison.scopeNote}</p>
            </div>
          </section>

          <section className="discovery-section" aria-labelledby="decision-guide">
            <div className="discovery-label">
              <span>03</span>
              <h2 id="decision-guide">How to choose</h2>
            </div>
            <div className="discovery-prose">
              {comparison.sections.map((section) => (
                <section key={section.heading} className={styles.proseSection}>
                  <h3>{section.heading}</h3>
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                  {section.bullets === undefined ? null : (
                    <ul>
                      {section.bullets.map((bullet) => (
                        <li key={bullet}>{bullet}</li>
                      ))}
                    </ul>
                  )}
                </section>
              ))}
            </div>
          </section>

          <section className="discovery-section" aria-labelledby="decision">
            <div className="discovery-label">
              <span>04</span>
              <h2 id="decision">Decision</h2>
            </div>
            <div className={styles.decision}>
              <p>{comparison.decision}</p>
              <p className={styles.checked}>
                Product scope checked against the official sources below on{" "}
                <time dateTime={VERIFIED}>July 15, 2026</time>.
              </p>
            </div>
          </section>

          <div className={styles.faqWrap}>
            <FaqSection faqs={comparison.faqs} headingId={`${comparison.slug}-faq`} />
          </div>

          <section className="discovery-section" aria-labelledby="official-sources">
            <div className="discovery-label">
              <span>05</span>
              <h2 id="official-sources">Official sources</h2>
            </div>
            <div className={styles.sources}>
              <p>
                These links support the current product-scope claims. Features and release status
                can change, so verify them again before a security or procurement decision.
              </p>
              <ul>
                {comparison.sourceRefs.map((source) => (
                  <li key={source.url}>
                    <a href={source.url}>{source.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="discovery-section" aria-labelledby="related-comparisons">
            <div className="discovery-label">
              <span>06</span>
              <h2 id="related-comparisons">Related comparisons</h2>
            </div>
            <div className="discovery-links">
              {comparison.related.map((item) => (
                <Link href={item.href} key={item.href}>
                  <strong>{item.title}</strong>
                  <span>{item.description}</span>
                  <b aria-hidden="true">→</b>
                </Link>
              ))}
            </div>
          </section>
        </article>
      </main>
      <MarketingFooter />
    </>
  );
}
