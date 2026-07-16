import Link from "next/link";
import { Breadcrumbs } from "../components/Breadcrumbs";
import { JsonLd } from "../components/JsonLd";
import { MarketingFooter, MarketingNav } from "../components/MarketingChrome";
import { publicMetadata, SITE_URL } from "../lib/public-metadata";
import { breadcrumbJsonLd } from "../lib/structured-data";
import { REGISTRY_VERIFIED_ON, SERVICES, SERVICE_PAGE_SAMPLES } from "./service-content";
import type { ServicePageContent } from "./service-types";
import styles from "./services.module.css";

const description =
  "Browse active Trusty Squire service flows. Ask your coding agent to sign up, sign in, create an API credential, and save it without putting the key in chat or code.";

export const metadata = publicMetadata(
  "Services your coding agent can set up",
  description,
  "/services",
);

export const dynamic = "force-static";

const groups = Array.from(
  SERVICE_PAGE_SAMPLES.reduce((index, service) => {
    const letter = service.name[0]?.toUpperCase() ?? "#";
    const group = index.get(letter) ?? [];
    group.push(service);
    index.set(letter, group);
    return index;
  }, new Map<string, ServicePageContent[]>()),
);

const breadcrumbs = [
  { name: "Home", path: "/" },
  { name: "Services", path: "/services" },
] as const;

const collectionJsonLd = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "Services your coding agent can set up",
  description,
  url: `${SITE_URL}/services`,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: SERVICE_PAGE_SAMPLES.length,
    itemListElement: SERVICE_PAGE_SAMPLES.map((service, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: service.name,
      url: `${SITE_URL}/services/${service.registry.service}`,
    })),
  },
};

export default function ServicesPage() {
  return (
    <div className={styles.shell}>
      <JsonLd data={collectionJsonLd} />
      <JsonLd data={breadcrumbJsonLd(breadcrumbs)} />
      <MarketingNav />
      <main className={styles.main}>
        <div className={styles.breadcrumbsWrap}>
          <Breadcrumbs items={breadcrumbs} />
        </div>

        <header className={styles.hubHeader}>
          <p className={styles.kicker}>Reviewed service flows</p>
          <h1>Five reviewed website signup flows for coding agents</h1>
          <p className={styles.deck}>
            Each detailed page below passed an editorial evidence gate against an active Trusty
            Squire registry skill. Ask for the outcome, let your agent work through the real
            website, and keep the generated provider credential out of chat, source code, and
            <code>.env</code> files.
          </p>
          <div className={styles.hubSummary}>
            <span>
              <strong>{SERVICES.length}</strong> active registry entries
            </span>
            <span>
              <strong>{SERVICE_PAGE_SAMPLES.length}</strong> detailed samples for review
            </span>
            <span>registry checked {REGISTRY_VERIFIED_ON}</span>
          </div>
        </header>

        <nav className={styles.alphabet} aria-label="Service index by letter">
          {groups.map(([letter]) => (
            <a href={`#services-${letter.toLowerCase()}`} key={letter}>
              {letter}
            </a>
          ))}
        </nav>

        {groups.map(([letter, services]) => (
          <section
            className={styles.letterGroup}
            id={`services-${letter.toLowerCase()}`}
            key={letter}
            aria-labelledby={`services-${letter.toLowerCase()}-heading`}
          >
            <h2 id={`services-${letter.toLowerCase()}-heading`}>{letter}</h2>
            <div className={styles.serviceIndex}>
              {services.map((service) => (
                <Link
                  className={styles.serviceRow}
                  href={`/services/${service.registry.service}`}
                  key={service.registry.service}
                >
                  <div>
                    <h3>{service.name}</h3>
                    <small>{service.category}</small>
                  </div>
                  <p>{service.summary}</p>
                  <b aria-hidden="true">→</b>
                </Link>
              ))}
            </div>
          </section>
        ))}

        <section
          className={styles.registryCatalog}
          id="active-registry"
          aria-labelledby="active-registry-heading"
        >
          <div>
            <p className={styles.kicker}>Registry coverage</p>
            <h2 id="active-registry-heading">Full active registry inventory</h2>
            <p>
              This inventory controls page eligibility, but active registry status alone is not a
              public signup-support claim. Some entries still need portability or signup-evidence
              review. Only the five detailed flows above are approved for indexable setup claims in
              this release.
            </p>
          </div>
          <ul>
            {SERVICES.map((service) => (
              <li key={service.registry.service}>{service.name}</li>
            ))}
          </ul>
        </section>

        <section className={styles.hubCta}>
          <div>
            <h2>Start with the outcome</h2>
            <p>
              Install Trusty Squire, restart your coding agent, then try one of the five reviewed
              flows above. The agent sees the job result, not the provider credential.
            </p>
          </div>
          <Link className={styles.primaryLink} href="/start">
            Install Trusty Squire
          </Link>
        </section>
      </main>
      <MarketingFooter />
    </div>
  );
}
