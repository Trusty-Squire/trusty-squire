import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { ServiceWorkerMount } from "@/components/shell/ServiceWorkerMount";
import "./globals.css";

// Self-hosted via next/font — Next downloads the font at build time and
// serves it as a static asset, so the runtime never hits Google's CDN.
// `display: 'swap'` keeps FCP fast at the cost of one font-swap flash.
// One family, end to end: Inter does body AND headings (headings just
// tighten weight + tracking — see globals.css).

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "Trusty Squire",
  description: "Your squire handles the rest.",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icons/192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  applicationName: "Trusty Squire",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "squire" },
};

export const viewport: Viewport = {
  themeColor: "#0d0d10",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        {children}
        <ServiceWorkerMount />
      </body>
    </html>
  );
}
