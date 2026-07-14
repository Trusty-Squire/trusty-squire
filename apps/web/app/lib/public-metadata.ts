import type { Metadata } from "next";

const SITE_URL = "https://trustysquire.ai";
const SOCIAL_IMAGE = {
  url: "/logo-400.png",
  width: 400,
  height: 400,
  alt: "Trusty Squire shield mark",
};

export function publicMetadata(title: string, description: string, path: string): Metadata {
  const url = new URL(path, SITE_URL).toString();
  const socialTitle = `${title} | Trusty Squire`;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title: socialTitle,
      description,
      url,
      siteName: "Trusty Squire",
      type: "website",
      images: [SOCIAL_IMAGE],
    },
    twitter: {
      card: "summary",
      title: socialTitle,
      description,
      images: [SOCIAL_IMAGE.url],
    },
  };
}

export function articleMetadata(
  title: string,
  description: string,
  path: string,
  publishedTime: string,
): Metadata {
  const metadata = publicMetadata(title, description, path);
  return {
    ...metadata,
    openGraph: {
      ...metadata.openGraph,
      type: "article",
      publishedTime,
    },
  };
}
