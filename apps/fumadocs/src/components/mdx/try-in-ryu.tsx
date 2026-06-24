import { ArrowUpRight } from "lucide-react";

/**
 * The canonical `ryu://open/<page>` navigation keys, mirrored from
 * `@ryu/protocol` DEEP_LINK_PAGES. Kept as a local copy because the docs site
 * does not depend on the desktop protocol package, and a key that drifts simply
 * renders a link the app ignores rather than breaking the build.
 */
const PAGE_LABELS: Record<string, string> = {
  chat: "Chat",
  agents: "Agents",
  models: "Models",
  skills: "Skills",
  tools: "Tools",
  spaces: "Spaces",
  workflows: "Workflows",
  automations: "Automations",
  monitors: "Monitors",
  marketplace: "Marketplace",
  settings: "Settings",
  channels: "Channels",
  timeline: "Timeline",
  delegation: "Delegation",
  credits: "Credits",
  fleet: "Fleet",
  extensions: "Extensions",
  apps: "Apps",
  engines: "Engines",
  store: "Store",
  calendar: "Calendar",
  services: "Services",
};

/**
 * An "Open in Ryu" call to action. It deep-links the installed desktop app
 * straight to the surface a lesson describes via `ryu://open/<page>`, keeping
 * the Academy's promise that every step maps to a real surface you can open
 * today. If the app is not installed the browser simply does nothing, so this
 * is a safe progressive enhancement rather than a hard dependency.
 */
export function TryInRyu({
  page,
  children,
}: {
  page: string;
  children?: string;
}) {
  const label = children ?? `Open ${PAGE_LABELS[page] ?? page} in Ryu`;
  return (
    <a
      className="not-prose my-4 inline-flex items-center gap-2 rounded-lg bg-fd-primary/10 px-3.5 py-2 font-medium text-fd-primary text-sm no-underline transition-colors hover:bg-fd-primary/15"
      href={`ryu://open/${encodeURIComponent(page)}`}
    >
      {label}
      <ArrowUpRight className="size-4" />
    </a>
  );
}
