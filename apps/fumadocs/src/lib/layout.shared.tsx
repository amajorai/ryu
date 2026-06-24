import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { RyuLogo } from "@/components/ryu-logo";

export const gitConfig = {
  user: "amajorai",
  repo: "ryu",
  branch: "main",
};

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      // Mirror the landing header (apps/web): ghost mark + lowercase "ryu". The
      // docs cap weight at medium, so this stays lighter than the marketing site.
      title: (
        <span className="inline-flex items-center gap-2">
          <RyuLogo />
          <span className="font-medium text-lg lowercase">ryu</span>
        </span>
      ),
    },
    // Cross-navigation shown in both the home and docs top nav, next to the
    // built-in search trigger. Kept short on purpose: the realm cards and ⌘K
    // search are the primary ways in.
    links: [
      { text: "Docs", url: "/docs/start-here" },
      { text: "Cookbook", url: "/docs/cookbook" },
      { text: "Academy", url: "/docs/academy" },
      { text: "API", url: "/docs/develop/api-reference" },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
