"use client";

import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { usePathname } from "next/navigation";
import type { ComponentProps, ReactNode } from "react";

/*
 * Per-root theming, matching the official Fumadocs docs site.
 *
 * Each root ("/docs/<segment>") owns an accent color defined as a CSS variable
 * "--<segment>-color" in global.css. We tint the root selector icon with it, and
 * a "data-docs-root" wrapper switches "--color-fd-primary" so the whole layout
 * (sidebar, content, TOC) takes on that root's color while you are inside it.
 */
function rootSegment(url: string): string {
  // url looks like "/docs/gateway" - take the segment after "docs".
  const parts = url.split("/").filter(Boolean);
  return parts[1] ?? "";
}

function rootColor(segment: string): string {
  return segment
    ? `var(--${segment}-color, var(--color-fd-foreground))`
    : "var(--color-fd-foreground)";
}

type DocsLayoutClientProps = ComponentProps<typeof DocsLayout> & {
  children: ReactNode;
};

export function DocsLayoutClient({
  children,
  ...props
}: DocsLayoutClientProps) {
  const pathname = usePathname();
  const activeRoot = rootSegment(pathname);

  return (
    // "display: contents" keeps this wrapper out of the layout box model (so it
    // never disturbs Fumadocs' sticky sidebar), while CSS variables still
    // cascade from "data-docs-root" to every descendant.
    <div data-docs-root={activeRoot} style={{ display: "contents" }}>
      <DocsLayout
        {...props}
        sidebar={{
          tabs: {
            transform(option, node) {
              const color = rootColor(rootSegment(option.url));
              return {
                ...option,
                icon: (
                  <div
                    className="size-full rounded-md p-1 [&_svg]:size-full max-md:p-1.5"
                    style={{
                      color,
                      backgroundColor: `color-mix(in oklab, ${color} 18%, transparent)`,
                    }}
                  >
                    {node.icon}
                  </div>
                ),
              };
            },
          },
        }}
      >
        {children}
      </DocsLayout>
    </div>
  );
}
