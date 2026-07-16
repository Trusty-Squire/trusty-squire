import type { Metadata } from "next";

export const SITE_URL = "https://trustysquire.ai";
const SOCIAL_IMAGE = {
  url: "/opengraph-image",
  width: 1200,
  height: 630,
  alt: "Trusty Squire completing a website signup and sealing the generated API key",
};

interface PublicMetadataOptions {
  /** Use when the supplied title already includes the Trusty Squire brand. */
  absoluteTitle?: boolean;
}

export function publicMetadata(
  title: string,
  description: string,
  path: string,
  options: PublicMetadataOptions = {},
): Metadata {
  const url = new URL(path, SITE_URL).toString();
  const socialTitle = options.absoluteTitle ? title : `${title} | Trusty Squire`;

  return {
    title: options.absoluteTitle ? { absolute: title } : title,
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
      card: "summary_large_image",
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
  modifiedTime: string = publishedTime,
): Metadata {
  const metadata = publicMetadata(title, description, path);
  return {
    ...metadata,
    openGraph: {
      ...metadata.openGraph,
      type: "article",
      publishedTime,
      modifiedTime,
    },
  };
}
