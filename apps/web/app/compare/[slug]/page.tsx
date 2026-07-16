import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicMetadata } from "../../lib/public-metadata";
import { ComparisonArticle } from "../_components/ComparisonArticle";
import { COMPARISON_SLUGS, getComparison } from "../content";

export const dynamicParams = false;

export function generateStaticParams() {
  return COMPARISON_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const comparison = getComparison(slug);
  if (comparison === undefined) return {};
  return publicMetadata(comparison.title, comparison.description, `/compare/${comparison.slug}`, {
    absoluteTitle: comparison.title.startsWith("Trusty Squire "),
  });
}

export default async function ComparePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const comparison = getComparison(slug);
  if (comparison === undefined) notFound();
  return <ComparisonArticle comparison={comparison} />;
}
