import type { Metadata, Viewport } from "next";

import { SUBREDDIT } from "@/lib/config";
import { DENSITY_INIT_SCRIPT, DEFAULT_DENSITY } from "@/lib/density";

import "./globals.css";

export const metadata: Metadata = {
  title: `Top posts · ${SUBREDDIT}`,
  description: `The top posts from ${SUBREDDIT}, read from Reddit's public RSS feed.`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0b0d10" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-density={DEFAULT_DENSITY} suppressHydrationWarning>
      <head>
        {/* Applies the reader's stored density before paint, avoiding a flash. */}
        <script dangerouslySetInnerHTML={{ __html: DENSITY_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen bg-white text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
        {children}
      </body>
    </html>
  );
}
