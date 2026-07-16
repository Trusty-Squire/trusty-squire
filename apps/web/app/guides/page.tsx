import Link from "next/link";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { FaqSection } from "../components/FaqSection";
import { JsonLd } from "../components/JsonLd";
import { MarketingFooter, MarketingNav } from "../components/MarketingChrome";
import { publicMetadata, SITE_URL } from "../lib/public-metadata";
import { breadcrumbJsonLd, faqPageJsonLd } from "../lib/structured-data";
import { GUIDES, GUIDE_SLUGS } from "./content";
import styles from "./guides.module.css";

const description =
  "Practical guides for coding-agent signup failures, leaked API keys, MCP credential vaults, bot-detection handoffs, and keeping reusable secrets out of model context.";

export const metadata = publicMetadata(
  "Guides for AI agent signups and API key safety",
  description,
  "/guides",
);

const FAQS = [
  {
    question: "Where should I start if my coding agent is blocked on signup?",
    answer:
      "Start with the account-creation guide. It separates missing browser identity, verification, human decisions, provider rejection, and incomplete post-signup setup.",
  },
  {
    question: "Where should I start after an API key reaches GitHub?",
    answer:
      "Use the leaked-key incident guide. Revoke or rotate the provider credential before deleting files or rewriting Git history.",
  },
  {
    question: "Are these guides specific to Trusty Squire?",
    answer:
      "No. Each guide begins with the general solution and tradeoffs. The Trusty Squire section explains where its website and credential tools fit, along with their limits.",
  },
  {
    question: "Do the guides promise every website signup can be automated?",
    answer:
      "No. Websites can require CAPTCHA, phone verification, payment, legal acceptance, or other user decisions. A responsible workflow pauses or reports the block instead of inventing success.",
  },
];

const BREADCRUMBS = [
  { name: "Home", path: "/" },
  { name: "Guides", path: "/guides" },
];

export default function GuidesPage() {
  const items = GUIDE_SLUGS.map((slug) => GUIDES[slug]);
  const itemListJsonLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Trusty Squire guides",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.title,
      url: `${SITE_URL}/guides/${item.slug}`,
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
            <p className="discovery-kicker">Practical guides</p>
            <h1>Fix the signup or credential problem in front of you</h1>
            <p className="discovery-deck">
              Start with the failure mode. These guides explain the general answer, the safety
              boundary, the recovery path, and only then where Trusty Squire helps.
            </p>
          </header>

          <section className="discovery-index" aria-label="AI agent and credential guides">
            {items.map((item, index) => (
              <Link href={`/guides/${item.slug}`} key={item.slug}>
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
            <h2>Use the narrowest guide</h2>
            <div>
              <p>
                A leaked key is an incident response problem. A blocked signup is an identity or
                website-flow problem. An MCP vault is a tool-contract problem. Treating all three as
                generic secret management hides the action you need to take next.
              </p>
              <p>
                If you are choosing a product rather than fixing an active issue, use the{" "}
                <Link href="/compare">comparison library</Link> to separate website provisioning,
                secret storage, runtime injection, vault administration, and MCP governance.
              </p>
            </div>
          </section>

          <div className={styles.faqWrap}>
            <FaqSection faqs={FAQS} headingId="guides-faq" />
          </div>
        </article>
      </main>
      <MarketingFooter />
    </>
  );
}
