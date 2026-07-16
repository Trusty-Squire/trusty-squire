import Link from "next/link";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { FaqSection } from "../components/FaqSection";
import { JsonLd } from "../components/JsonLd";
import { MarketingFooter, MarketingNav } from "../components/MarketingChrome";
import { publicMetadata, SITE_URL } from "../lib/public-metadata";
import { breadcrumbJsonLd, faqPageJsonLd } from "../lib/structured-data";
import { COMPARISONS, COMPARISON_SLUGS } from "./content";
import styles from "./compare.module.css";

const description =
  "Factual comparisons of Trusty Squire, 1Password MCP, HashiCorp Vault, Infisical, Doppler, and AWS Secrets Manager for AI-agent credentials and website provisioning.";

export const metadata = publicMetadata(
  "Compare credential tools for AI agents",
  description,
  "/compare",
);

const FAQS = [
  {
    question: "Is there one best secret manager for every AI agent?",
    answer:
      "No. Local coding agents, CI runners, hosted agents, and production services have different identity, approval, delivery, rotation, and availability needs.",
  },
  {
    question: "What makes Trusty Squire different from a secret manager?",
    answer:
      "Trusty Squire can operate the provider website before a credential exists, then capture and use that credential through constrained tools. Most secret managers begin after a value or supported issuer already exists.",
  },
  {
    question: "Does connecting a vault through MCP keep secrets out of context?",
    answer:
      "Not automatically. Some MCP tools inject or use a secret without returning it, while others directly return plaintext. Inspect each tool's exact response contract and the client's logging behavior.",
  },
  {
    question: "Can these products be used together?",
    answer:
      "Yes. A provisioning layer, team password manager, infrastructure vault, and cloud secret service can own different stages. Give each credential one authoritative system and one rotation owner.",
  },
];

const BREADCRUMBS = [
  { name: "Home", path: "/" },
  { name: "Compare", path: "/compare" },
];

export default function ComparisonsPage() {
  const items = COMPARISON_SLUGS.map((slug) => COMPARISONS[slug]);
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Trusty Squire product comparisons",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.title,
      url: `${SITE_URL}/compare/${item.slug}`,
    })),
  };

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(BREADCRUMBS)} />
      <JsonLd data={faqPageJsonLd(FAQS)} />
      <JsonLd data={itemListJsonLd} />
      <MarketingNav />
      <main>
        <article className="discovery">
          <Breadcrumbs items={BREADCRUMBS} />
          <header className="discovery-head discovery-head-compact">
            <p className="discovery-kicker">Product comparisons</p>
            <h1>Choose by the credential job, not the category label</h1>
            <p className="discovery-deck">
              These comparisons separate website signup, secret storage, runtime injection, direct
              vault access, and MCP governance. Every competitor claim links to an official source
              and carries a verification date.
            </p>
          </header>

          <section className="discovery-index" aria-label="AI agent credential comparisons">
            {items.map((item, index) => (
              <Link href={`/compare/${item.slug}`} key={item.slug}>
                <span className="discovery-index-number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h2>{item.title}</h2>
                  <p>{item.description}</p>
                </div>
                <b aria-hidden="true">→</b>
              </Link>
            ))}
          </section>

          <section className="discovery-context">
            <h2>Start with one boundary</h2>
            <div>
              <p>
                Does the account exist? Does the agent need the plaintext value, or only one
                authenticated action? Is the target a local process, CI job, hosted browser, or
                production service? Those answers remove more options than a feature checklist.
              </p>
              <p>
                If you are fixing a specific leak, signup block, or context-exposure risk, use the{" "}
                <Link href="/guides">practical guides</Link> first. They begin with the immediate
                action rather than a product choice.
              </p>
            </div>
          </section>

          <div className={styles.faqWrap}>
            <FaqSection faqs={FAQS} headingId="compare-faq" />
          </div>
        </article>
      </main>
      <MarketingFooter />
    </>
  );
}
