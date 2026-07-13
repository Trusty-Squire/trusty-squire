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
    "Trusty Squire lets Claude Code, Codex, Cursor, and other coding agents sign up for websites, sign in, configure services, and save API keys without putting them in chat or code.",
  metadataBase: new URL("https://trustysquire.ai"),
  applicationName: "Trusty Squire",
  keywords: [
    "AI agent website signup",
    "coding agent MCP",
    "Claude Code MCP",
    "Codex MCP",
    "Cursor MCP",
    "API keys without .env",
  ],
  openGraph: {
    title: "Trusty Squire: AI agents that sign up and sign in to websites",
    description:
      "Let your coding agent sign up for websites, sign in, configure services, and save generated credentials without putting them in chat, code, or .env.",
    url: "https://trustysquire.ai/",
    siteName: "Trusty Squire",
    type: "website",
    images: [
      {
        url: "/logo-400.png",
        width: 400,
        height: 400,
        alt: "Trusty Squire shield mark",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Trusty Squire: AI agents that sign up and sign in to websites",
    description:
      "Let your coding agent sign up, sign in, configure services, and save generated credentials without putting them in chat or code.",
    images: ["/logo-400.png"],
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
