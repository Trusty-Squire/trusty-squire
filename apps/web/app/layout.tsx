import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Geist is the UI/body face (design system: replaces Inter, the
// convergence trap). next/font/google ships Geist in this Next, so we
// avoid the extra `geist` dependency. No `weight` → the variable font
// loads, so the design's body weight 450 (a non-discrete value) and the
// 600 headings both resolve from one file.
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Trusty Squire: empower agents with auth and payments",
    template: "%s | Trusty Squire",
  },
  description:
    "Trusty Squire empowers coding agents with auth and payments — MCP tools to sign up, sign in, and pay, keeping your keys and card in a write-only vault.",
  metadataBase: new URL("https://trustysquire.ai"),
  applicationName: "Trusty Squire",
  keywords: [
    "AI agent website signup",
    "coding agent MCP",
    "Claude Code MCP",
    "Codex MCP",
    "Cursor MCP",
    "OpenCode MCP",
    "MCP credential vault",
    "AI agent secrets management",
    "automate website signup",
    "API keys without .env",
  ],
  openGraph: {
    title: "Trusty Squire: empower agents with auth and payments",
    description:
      "Trusty Squire empowers coding agents with auth and payments — MCP tools to sign up, sign in, and pay, keeping your keys and card in a write-only vault.",
    url: "https://trustysquire.ai/",
    siteName: "Trusty Squire",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Trusty Squire empowering an agent with auth and payments, keys and card kept in a write-only vault",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Trusty Squire: empower agents with auth and payments",
    description:
      "Trusty Squire empowers coding agents with auth and payments — MCP tools to sign up, sign in, and pay, keeping your keys and card in a write-only vault.",
    images: ["/opengraph-image"],
  },
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
