import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";

import "./global.css";
import { Geist, Inter } from "next/font/google";

const inter = Inter({
  subsets: ["latin"],
});

// Headings use Geist; body keeps Inter. Both are exposed as CSS variables and
// wired up in global.css (`--font-heading` maps to Geist).
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
});

export const metadata: Metadata = {
  title: "Ryu Docs",
  description:
    "Documentation for Ryu — the orchestration and control layer for AI agents",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${inter.className}`}
      suppressHydrationWarning
    >
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
