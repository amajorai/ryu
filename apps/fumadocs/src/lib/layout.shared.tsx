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
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
