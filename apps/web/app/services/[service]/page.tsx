import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { FaqSection } from "../../components/FaqSection";
import { JsonLd } from "../../components/JsonLd";
import { MarketingFooter, MarketingNav } from "../../components/MarketingChrome";
import { publicMetadata } from "../../lib/public-metadata";
import { breadcrumbJsonLd, faqPageJsonLd } from "../../lib/structured-data";
import {
  appAccessSnippet,
  describeRegistryStep,
  getRelatedServices,
  getServiceFaqs,
  getServicePage,
  publicCredentialDescription,
  REGISTRY_VERIFIED_ON,
  SERVICE_PAGE_SAMPLES,
} from "../service-content";
import styles from "../services.module.css";

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return SERVICE_PAGE_SAMPLES.map((service) => ({ service: service.registry.service }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ service: string }>;
}): Promise<Metadata> {
  const { service: slug } = await params;
  const service = getServicePage(slug);
  if (service === undefined) return { title: "Service not found" };

  return publicMetadata(
    `Let Claude Code sign up for ${service.name} and store the API key safely — Trusty Squire`,
    service.metaDescription,
    `/services/${service.registry.service}`,
    { absoluteTitle: true },
  );
}

function credentialDetail(service: NonNullable<ReturnType<typeof getServicePage>>, index: number) {
  const credential = service.registry.credentials[index];
  if (credential === undefined) return null;
  return (
    <li key={`${credential.env_var_suggestion}-${index}`}>
      <code>{credential.env_var_suggestion}</code>
      <p>{publicCredentialDescription(service, credential, index)}</p>
    </li>
  );
}

export default async function ServicePage({ params }: { params: Promise<{ service: string }> }) {
  const { service: slug } = await params;
  const service = getServicePage(slug);
  if (service === undefined) notFound();

  const faqs = getServiceFaqs(service);
  const related = getRelatedServices(service);
  const breadcrumbs = [
    { name: "Home", path: "/" },
    { name: "Services", path: "/services" },
    { name: service.name, path: `/services/${service.registry.service}` },
  ] as const;
  return (
    <div className={styles.shell}>
      <JsonLd data={breadcrumbJsonLd(breadcrumbs)} />
      <JsonLd data={faqPageJsonLd(faqs)} />
      <MarketingNav />
      <main className={styles.main}>
        <div className={styles.breadcrumbsWrap}>
          <Breadcrumbs items={breadcrumbs} />
        </div>

        <header className={styles.serviceHeader}>
          <p className={styles.kicker}>{service.category}</p>
          <h1>Sign up for {service.name} and keep its API key out of agent context</h1>
          <div className={styles.intro}>
            {service.published.intro.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
          <blockquote className={styles.prompt}>
            <span>Ask your coding agent</span>“{service.published.prompt}”
          </blockquote>
        </header>

        <dl className={styles.facts}>
          <div>
            <dt>Registry status</dt>
            <dd>Active</dd>
          </div>
          <div>
            <dt>Recorded actions</dt>
            <dd>{service.registry.source_step_count}</dd>
          </div>
          <div>
            <dt>Credential fields</dt>
            <dd>{service.registry.credentials.length}</dd>
          </div>
          <div>
            <dt>Provider entry</dt>
            <dd>
              <a href={service.publicSignupUrl} rel="noreferrer">
                {new URL(service.publicSignupUrl).hostname}
              </a>
            </dd>
          </div>
        </dl>

        <div className={styles.contentGrid}>
          <article className={styles.article}>
            <section className={styles.section} aria-labelledby="service-outcome">
              <h2 id="service-outcome">What this setup unlocks</h2>
              <p>{service.outcome}</p>
              <ul className={styles.useCases}>
                {service.useCases.map((useCase) => (
                  <li key={useCase}>{useCase}</li>
                ))}
              </ul>
            </section>

            <section className={styles.section} aria-labelledby="service-steps">
              <h2 id="service-steps">What your agent does</h2>
              <p>
                These public steps preserve the active registry flow while omitting captured account
                identifiers, brittle DOM selectors, and literal form values.
              </p>
              <ol className={styles.steps}>
                {service.registry.steps.map((step, index) => (
                  <li key={`${step.kind}-${index}`}>
                    <span className={styles.stepNumber}>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <p className={styles.stepKind}>{step.kind.replaceAll("_", " ")}</p>
                      <p className={styles.stepText}>{describeRegistryStep(step)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className={styles.section} aria-labelledby="service-credential">
              <h2 id="service-credential">Credential saved to the vault</h2>
              <ul className={styles.credentialList}>
                {service.registry.credentials.map((_, index) => credentialDetail(service, index))}
              </ul>
              <div className={styles.safety}>
                <strong>Write-only by design.</strong> {service.vaultSafety}
              </div>
            </section>

            <section className={styles.section} aria-labelledby="service-injection">
              <h2 id="service-injection">Use it without revealing the provider key</h2>
              <p>
                In the Vault, first make <code>{service.published.integration.apiHost}</code> the
                credential&apos;s primary allowed host. Then ask your agent to call{" "}
                <code>grant_app_access</code>. It returns a host-scoped egress base URL and a
                revocable token; the backend uses those values to{" "}
                {service.published.integration.operation}.
              </p>
              <pre className={styles.codeBlock}>
                <code>{appAccessSnippet(service)}</code>
              </pre>
              <p>
                Provider request checked against{" "}
                <a href={service.published.integration.docsUrl} rel="noreferrer">
                  {service.published.integration.docsLabel}
                </a>{" "}
                on {REGISTRY_VERIFIED_ON}.
              </p>
              <div className={styles.safety}>
                <strong>The egress token is still a secret.</strong> Keep{" "}
                <code>SQUIRE_EGRESS_TOKEN</code> in backend-only secret storage. Do not expose it in
                browser JavaScript, logs, or source control. <code>grant_app_access</code> returns
                this scoped token once through the MCP result, so it can enter agent context; it is
                not the provider key. Move it directly into your deployment&apos;s secret store, or
                use
                <code>use_credential</code> when you need zero grant-token exposure. Grants are
                host-scoped, audited, and revocable without rotating the provider credential.
              </div>
            </section>

            <div className={styles.faqWrap}>
              <FaqSection faqs={faqs} />
            </div>
          </article>

          <aside className={styles.side} aria-label="Related service information">
            <section className={styles.sideBlock}>
              <h2>Related reviewed services</h2>
              <ul>
                {related.map((item) => (
                  <li key={item.registry.service}>
                    <Link href={`/services/${item.registry.service}`}>
                      {item.name}: {item.summary}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
            <section className={styles.sideBlock}>
              <h2>Next steps</h2>
              <ul>
                <li>
                  <Link href="/start">Install Trusty Squire</Link>
                </li>
                <li>
                  <Link href="/use-cases/website-signup">How website signup works</Link>
                </li>
                <li>
                  <Link href="/use-cases/api-keys-without-env">API keys without .env</Link>
                </li>
                <li>
                  <Link href="/guides/coding-agent-create-account">Coding agent signup guide</Link>
                </li>
                <li>
                  <Link href="/guides/secure-api-key-storage-for-ai-agents">
                    Secure API key storage guide
                  </Link>
                </li>
                <li>
                  <Link href="/compare/best-mcp-credential-management">
                    Compare MCP credential tools
                  </Link>
                </li>
                <li>
                  <Link href="/compare/best-api-key-storage-ai-agents">
                    Compare API key storage
                  </Link>
                </li>
              </ul>
            </section>
            <section className={styles.sideBlock}>
              <h2>Registry record</h2>
              <p className={styles.registryMeta}>
                {service.registry.skill_id}
                <br />
                {service.registry.version}
                <br />
                status: {service.registry.status}
                <br />
                checked: {REGISTRY_VERIFIED_ON}
              </p>
            </section>
          </aside>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}
