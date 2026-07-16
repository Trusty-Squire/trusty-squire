import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { JsonLd } from "../../components/JsonLd";
import { Shield } from "../../components/Shield";
import { articleMetadata } from "../../lib/public-metadata";
import { articleJsonLd, breadcrumbJsonLd } from "../../lib/structured-data";
import { POSTS, getPost } from "../posts";

const NPM_URL = "https://www.npmjs.com/package/@trusty-squire/mcp";
const GITHUB_URL = "https://github.com/Trusty-Squire/trusty-squire";

export function generateStaticParams() {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (post === undefined) return { title: "Not found" };
  return articleMetadata(
    post.title,
    post.description,
    `/blog/${post.slug}`,
    post.iso,
    post.modifiedIso,
  );
}

export default async function PostPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (post === undefined) notFound();
  const { Body } = post;

  return (
    <main>
      <JsonLd
        data={articleJsonLd({
          title: post.title,
          description: post.description,
          path: `/blog/${post.slug}`,
          datePublished: post.iso,
          dateModified: post.modifiedIso ?? post.iso,
        })}
      />
      <JsonLd
        data={breadcrumbJsonLd([
          { name: "Home", path: "/" },
          { name: "Blog", path: "/blog" },
          { name: post.title, path: `/blog/${post.slug}` },
        ])}
      />
      <nav className="site-nav">
        <div className="nav-in">
          <Link className="brand" href="/">
            <Shield size={22} glyph />
            Trusty Squire
          </Link>
          <div className="nav-r">
            <a href={GITHUB_URL}>GitHub</a>
            <Link className="signin" href="/login">
              Sign in
            </Link>
            <Link className="pill" href="/start">
              Install
            </Link>
          </div>
        </div>
      </nav>

      <article className="post">
        <Link className="post-back" href="/blog">
          ← Blog
        </Link>
        <h1>{post.title}</h1>
        <p className="post-meta">
          <time dateTime={post.iso}>{post.date}</time>
        </p>
        <Body />
      </article>

      <footer>
        <div className="wrap">
          <div className="foot">
            <Link className="brand" href="/">
              <Shield size={17} />
              Trusty Squire
            </Link>
            <div className="foot-l">
              <Link href="/blog">Blog</Link>
              <Link href="/privacy">Privacy</Link>
              <Link href="/terms">Terms</Link>
              <a href={NPM_URL}>npm</a>
              <a href={GITHUB_URL}>GitHub</a>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}
