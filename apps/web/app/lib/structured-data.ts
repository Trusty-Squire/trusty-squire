import { SITE_URL } from "./public-metadata";

export interface FaqItem {
  question: string;
  answer: string;
}

export interface BreadcrumbItem {
  name: string;
  path: string;
}

export interface HowToStep {
  name: string;
  text: string;
}

function absoluteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

export function faqPageJsonLd(faqs: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  };
}

export function breadcrumbJsonLd(items: readonly BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export function articleJsonLd(input: {
  title: string;
  description: string;
  path: string;
  datePublished?: string;
  dateModified?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: input.title,
    description: input.description,
    url: absoluteUrl(input.path),
    mainEntityOfPage: absoluteUrl(input.path),
    ...(input.datePublished === undefined ? {} : { datePublished: input.datePublished }),
    ...(input.dateModified === undefined ? {} : { dateModified: input.dateModified }),
    author: {
      "@type": "Organization",
      name: "Trusty Squire",
      url: `${SITE_URL}/`,
    },
    publisher: {
      "@type": "Organization",
      name: "Trusty Squire",
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/logo-400.png`,
      },
    },
  };
}

export function howToJsonLd(input: {
  title: string;
  description: string;
  path: string;
  steps: readonly HowToStep[];
}) {
  return {
    "@context": "https://schema.org",
    "@type": "HowTo",
    name: input.title,
    description: input.description,
    url: absoluteUrl(input.path),
    step: input.steps.map((step, index) => ({
      "@type": "HowToStep",
      position: index + 1,
      name: step.name,
      text: step.text,
    })),
  };
}

export const softwareApplicationJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "@id": `${SITE_URL}/#software`,
  name: "Trusty Squire",
  applicationCategory: "DeveloperApplication",
  applicationSubCategory: "MCP server",
  operatingSystem: "macOS, Linux, Windows",
  url: `${SITE_URL}/`,
  downloadUrl: "https://www.npmjs.com/package/@trusty-squire/mcp",
  softwareHelp: "https://github.com/trusty-squire/trusty-squire#readme",
  description:
    "An MCP server that lets coding agents sign up and sign in to websites, finish setup, and store generated credentials in a write-only vault.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    description: "Free to start",
  },
  featureList: [
    "Website signup and sign-in for coding agents",
    "Authenticated website setup",
    "Encrypted write-only credential vault",
    "Server-side credential injection",
  ],
};
