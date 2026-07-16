import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { publicMetadata } from "../../lib/public-metadata";
import { GuideArticle } from "../_components/GuideArticle";
import { getGuide, GUIDE_SLUGS } from "../content";

export const dynamicParams = false;

export function generateStaticParams() {
  return GUIDE_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = getGuide(slug);
  if (guide === undefined) return {};
  return publicMetadata(guide.title, guide.description, `/guides/${guide.slug}`);
}

export default async function GuidePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const guide = getGuide(slug);
  if (guide === undefined) notFound();
  return <GuideArticle guide={guide} />;
}
