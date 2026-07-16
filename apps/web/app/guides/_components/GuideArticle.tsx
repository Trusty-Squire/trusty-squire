import Link from "next/link";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { FaqSection } from "../../components/FaqSection";
import { JsonLd } from "../../components/JsonLd";
import { MarketingFooter, MarketingNav } from "../../components/MarketingChrome";
import {
  articleJsonLd,
  breadcrumbJsonLd,
  faqPageJsonLd,
  howToJsonLd,
} from "../../lib/structured-data";
import type { GuideContent } from "../content";
import styles from "./guide-article.module.css";

const PUBLISHED = "2026-07-15";

export function GuideArticle({ guide }: { guide: GuideContent }) {
  const path = `/guides/${guide.slug}`;
  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Guides", path: "/guides" },
    { name: guide.shortTitle, path },
  ];
  const primaryJsonLd =
    guide.schemaType === "HowTo"
      ? howToJsonLd({
          title: guide.title,
          description: guide.description,
          path,
          steps: guide.steps.map((step) => ({ name: step.title, text: step.description })),
        })
      : articleJsonLd({
          title: guide.title,
          description: guide.description,
          path,
          datePublished: PUBLISHED,
          dateModified: PUBLISHED,
        });

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs)} />
      <JsonLd data={faqPageJsonLd(guide.faqs)} />
      <JsonLd data={primaryJsonLd} />
      <MarketingNav />
      <main>
        <article className="discovery">
          <Breadcrumbs items={breadcrumbs} />
          <header className="discovery-head">
            <p className="discovery-kicker">Guide / {guide.eyebrow}</p>
            <h1>{guide.title}</h1>
            <p className="discovery-deck">{guide.description}</p>
          </header>

          <section className="discovery-section" aria-labelledby="short-answer">
            <div className="discovery-label">
              <span>01</span>
              <h2 id="short-answer">Short answer</h2>
            </div>
            <div className={styles.answer}>
              {guide.answer.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {guide.answerChecks.length > 0 ? (
                <ul>
                  {guide.answerChecks.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </section>

          <section className="discovery-section" aria-labelledby="action-plan">
            <div className="discovery-label">
              <span>02</span>
              <h2 id="action-plan">Action plan</h2>
            </div>
            <ol className="discovery-steps">
              {guide.steps.map((step, index) => (
                <li key={step.title}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>{step.description}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <section className="discovery-section" aria-labelledby="details">
            <div className="discovery-label">
              <span>03</span>
              <h2 id="details">What to know</h2>
            </div>
            <div className="discovery-prose">
              {guide.sections.map((section) => (
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

          <section className="discovery-section" aria-labelledby="trusty-squire-fit">
            <div className="discovery-label">
              <span>04</span>
              <h2 id="trusty-squire-fit">Where Trusty Squire fits</h2>
            </div>
            <div className="discovery-prose">
              {guide.productFit.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              <div className={styles.limit}>
                <strong>Limits to keep in view</strong>
                <ul>
                  {guide.limits.map((limit) => (
                    <li key={limit}>{limit}</li>
                  ))}
                </ul>
              </div>
              <p>
                <Link href="/start">Install Trusty Squire</Link> when the missing piece is the
                website work or a credential boundary for your coding agent.
              </p>
            </div>
          </section>

          <div className={styles.faqWrap}>
            <FaqSection faqs={guide.faqs} headingId={`${guide.slug}-faq`} />
          </div>

          {guide.sourceRefs.length > 0 ? (
            <section className="discovery-section" aria-labelledby="sources">
              <div className="discovery-label">
                <span>05</span>
                <h2 id="sources">Primary sources</h2>
              </div>
              <div className={styles.sources}>
                <p>Official documentation used for the factual claims on this page.</p>
                <ul>
                  {guide.sourceRefs.map((source) => (
                    <li key={source.url}>
                      <a href={source.url}>{source.label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          <section className="discovery-section" aria-labelledby="related">
            <div className="discovery-label">
              <span>{guide.sourceRefs.length > 0 ? "06" : "05"}</span>
              <h2 id="related">Related guides</h2>
            </div>
            <div className="discovery-links">
              {guide.related.map((item) => (
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
