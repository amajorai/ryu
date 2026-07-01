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
      // Just the ghost mark — the animated outline logo, no wordmark.
      title: (
        <span className="inline-flex items-center">
          <RyuLogo />
        </span>
      ),
    },
    // Cross-navigation shown in both the home and docs top nav, next to the
    // built-in search trigger. Kept deliberately minimal: the in-sidebar root
    // selector switches between realms, the home realm cards list them all, and
    // ⌘K search is the primary way in, so the top nav only carries the two deep
    // destinations that aren't a realm root.
    links: [
      { text: "Get started", url: "/docs/start-here" },
      { text: "API", url: "/docs/develop/api-reference" },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
