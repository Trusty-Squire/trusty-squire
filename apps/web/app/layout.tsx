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
  title: "Trusty Squire — Vibe code. Your squire handles the rest.",
  description:
    "Trusty Squire automates SaaS signups inside your coding agent and secures the keys in your hardware. Built for Claude Code, Codex, Goose, and Cursor.",
  metadataBase: new URL("https://trustysquire.ai"),
  openGraph: {
    title: "Trusty Squire — Vibe code. Your squire handles the rest.",
    description:
      "Automates SaaS signups in your coding agent. Secures keys in your hardware. Spends within your guardrails.",
    url: "https://trustysquire.ai",
    siteName: "Trusty Squire",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Trusty Squire",
    description:
      "Vibe code. Your squire handles the rest.",
  },
  icons: {
    icon: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${geist.variable} ${jetbrainsMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
