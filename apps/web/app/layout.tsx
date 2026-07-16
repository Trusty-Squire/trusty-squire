import type { Metadata } from "next";
import { Geist, JetBrains_Mono } from "next/font/google";
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

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: {
    default: "Trusty Squire: AI agents that sign up and sign in to websites",
    template: "%s | Trusty Squire",
  },
  description:
    "Trusty Squire is an MCP server that lets Claude Code, Codex, Cursor, and other coding agents sign up for websites and save API keys outside chat, code, and .env.",
  metadataBase: new URL("https://trustysquire.ai"),
  applicationName: "Trusty Squire",
  keywords: [
    "AI agent website signup",
    "coding agent MCP",
    "Claude Code MCP",
    "Codex MCP",
    "Cursor MCP",
    "MCP credential vault",
    "AI agent secrets management",
    "automate website signup",
    "API keys without .env",
  ],
  openGraph: {
    title: "Trusty Squire: AI agents that sign up and sign in to websites",
    description:
      "An MCP server that gets coding agents through website signup and stores generated credentials outside chat, code, and .env.",
    url: "https://trustysquire.ai/",
    siteName: "Trusty Squire",
    type: "website",
    images: [
      {
        url: "/opengraph-image",
        width: 1200,
        height: 630,
        alt: "Trusty Squire completing a website signup and sealing the generated API key",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Trusty Squire: AI agents that sign up and sign in to websites",
    description:
      "An MCP server that gets coding agents through website signup and stores generated credentials outside chat, code, and .env.",
    images: ["/opengraph-image"],
  },
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${geist.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
