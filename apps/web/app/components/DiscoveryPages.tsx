import type { ReactNode } from "react";
import Link from "next/link";
import { CopyChip } from "./CopyChip";
import { MarketingFooter, MarketingNav } from "./MarketingChrome";

export interface DiscoveryExample {
  prompt: string;
  result: string;
}

export interface DiscoveryStep {
  title: string;
  description: string;
}

export interface DiscoveryLink {
  href: string;
  title: string;
  description: string;
}

interface DiscoveryDetailProps {
  eyebrow: string;
  title: string;
  deck: string;
  examples: DiscoveryExample[];
  steps: DiscoveryStep[];
  related: DiscoveryLink[];
  children: ReactNode;
  installCommand?: string;
}

export function DiscoveryDetail({
  eyebrow,
  title,
  deck,
  examples,
  steps,
  related,
  children,
  installCommand,
}: DiscoveryDetailProps) {
  return (
    <>
      <MarketingNav />
      <main>
        <article className="discovery">
          <header className="discovery-head">
            <p className="discovery-kicker">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="discovery-deck">{deck}</p>
            <div className="discovery-install">
              {installCommand === undefined ? <CopyChip /> : <code>{installCommand}</code>}
              <Link href="/start">Installation guide →</Link>
            </div>
          </header>

          <section className="discovery-section" aria-labelledby="example-asks">
            <div className="discovery-label">
              <span>01</span>
              <h2 id="example-asks">Ask for the outcome</h2>
            </div>
            <div className="discovery-asks">
              {examples.map((example) => (
                <blockquote key={example.prompt}>
                  <p>“{example.prompt}”</p>
                  <footer>{example.result}</footer>
                </blockquote>
              ))}
            </div>
          </section>

          <section className="discovery-section" aria-labelledby="how-it-works">
            <div className="discovery-label">
              <span>02</span>
              <h2 id="how-it-works">How it works</h2>
            </div>
            <ol className="discovery-steps">
              {steps.map((step, index) => (
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
            <div className="discovery-prose">{children}</div>
          </section>

          <section className="discovery-section" aria-labelledby="related">
            <div className="discovery-label">
              <span>04</span>
              <h2 id="related">Keep going</h2>
            </div>
            <div className="discovery-links">
              {related.map((item) => (
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

interface DiscoveryHubProps {
  eyebrow: string;
  title: string;
  deck: string;
  items: DiscoveryLink[];
  children: ReactNode;
}

export function DiscoveryHub({ eyebrow, title, deck, items, children }: DiscoveryHubProps) {
  return (
    <>
      <MarketingNav />
      <main>
        <article className="discovery">
          <header className="discovery-head discovery-head-compact">
            <p className="discovery-kicker">{eyebrow}</p>
            <h1>{title}</h1>
            <p className="discovery-deck">{deck}</p>
          </header>

          <section className="discovery-index" aria-label={eyebrow}>
            {items.map((item, index) => (
              <Link href={item.href} key={item.href}>
                <span className="discovery-index-number">{String(index + 1).padStart(2, "0")}</span>
                <div>
                  <h2>{item.title}</h2>
                  <p>{item.description}</p>
                </div>
                <b aria-hidden="true">→</b>
              </Link>
            ))}
          </section>

          <section className="discovery-context">{children}</section>
        </article>
      </main>
      <MarketingFooter />
    </>
  );
}
