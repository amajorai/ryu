// apps/desktop/src/lib/page-routes.ts
//
// The surface-agnostic PAGE KEY vocabulary (`chat`, `spaces`, `apps`, …) and the
// desktop tab routes it resolves to.
//
// This map used to live inside `DeepLinkController.tsx`, where it was the
// allowlist an inbound `ryu://open/<page>` link is checked against. It moved here
// because a SECOND consumer needs exactly the same allowlist: the workspace dock
// can host a page (see `dock-panels.ts`'s `route:` tab kind), and the programmatic
// seam that opens one — `useSidePanelRouteStore` — must be reachable by
// system-/agent-controlled callers WITHOUT letting them name an arbitrary path.
//
// Keeping one map is the point: a key that cannot be deep-linked to cannot be
// raised in the side panel either, and adding a page to one surface adds it to
// both. The module is PURE (no React, no Tauri) so both consumers — a component
// that imports the Tauri deep-link plugin, and the pure dock helpers — can share
// it without dragging the other's dependencies along.

/**
 * Page key → desktop tab route. An unknown key resolves to nothing, so a
 * malicious or stale link (or an agent-chosen key) can't navigate somewhere
 * unexpected. "apps"/"plugins" share the plugins route.
 */
export const PAGE_ROUTES: Record<string, string> = {
	chat: "/chat",
	// Agents/Spaces/Workflows are consolidated into the unified Library; deep
	// links open the matching Library tab.
	agents: "/library/agent",
	models: "/models",
	skills: "/skills",
	tools: "/tools",
	spaces: "/library/space",
	workflows: "/library/workflow",
	// Channels/Identities browse in Library; manage pages are /channels/:id and
	// /identities/profile/:id (see builtins.ts).
	channels: "/library/channel",
	identities: "/library/identity",
	vault: "/vault",
	// `automations` was merged into Workflows; keep the alias pointing at the
	// surviving surface so existing ryu://…automations deep links still resolve.
	automations: "/library/workflow",
	monitors: "/monitors",
	// Approvals live inside the unified Inbox; the /approvals route resolves there.
	approvals: "/approvals",
	marketplace: "/marketplace",
	settings: "/settings",
	timeline: "/timeline",
	review: "/review",
	fleet: "/fleet",
	extensions: "/extensions",
	apps: "/apps",
	plugins: "/apps",
	engines: "/engines",
	store: "/store",
	calendar: "/calendar",
};

/**
 * The route a page key names, or `undefined` for a key outside the vocabulary.
 *
 * `hasOwn` + the `typeof` re-check are not belt-and-braces: `PAGE_ROUTES` is an
 * object literal, so a bare `PAGE_ROUTES[page]` resolves `"toString"` and
 * `"constructor"` up the prototype chain and hands back a FUNCTION. TypeScript
 * types the index access as `string`, so nothing catches it at build time, and the
 * value is truthy — it would sail past every `if (!route)` guard and blow up on
 * the first string operation downstream. This function is the allowlist an
 * agent-chosen key is checked against, so an own-property check is the whole job.
 */
export function pageRoute(page: string): string | undefined {
	if (!Object.hasOwn(PAGE_ROUTES, page)) {
		return undefined;
	}
	const path = PAGE_ROUTES[page];
	return typeof path === "string" ? path : undefined;
}

/**
 * The pages OFFERED in the dock's "+" menu, in menu order.
 *
 * A subset of {@link PAGE_ROUTES}, not the whole map: the map carries aliases
 * (`automations` → Workflows, `plugins` → Apps) that would read as duplicate rows,
 * and `settings` is a modal surface everywhere else in the shell. Every entry here
 * still resolves through the map above, so the menu can never offer a page the
 * allowlist would refuse.
 */
export const SIDE_PANEL_PAGES: { label: string; page: string }[] = [
	{ page: "chat", label: "Chat" },
	{ page: "spaces", label: "Spaces" },
	{ page: "agents", label: "Agents" },
	{ page: "workflows", label: "Workflows" },
	{ page: "channels", label: "Channels" },
	{ page: "identities", label: "Profiles" },
	{ page: "vault", label: "Vault" },
	{ page: "tools", label: "Tools" },
	{ page: "skills", label: "Skills" },
	{ page: "models", label: "Models" },
	{ page: "apps", label: "Apps" },
	{ page: "store", label: "Store" },
	{ page: "monitors", label: "Monitors" },
	{ page: "timeline", label: "Timeline" },
	{ page: "approvals", label: "Inbox" },
	{ page: "calendar", label: "Calendar" },
];

/** The menu label for a page key (falls back to the key itself). */
export function pageLabel(page: string): string {
	return SIDE_PANEL_PAGES.find((p) => p.page === page)?.label ?? page;
}
