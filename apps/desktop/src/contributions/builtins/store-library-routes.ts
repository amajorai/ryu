// The Store, Library and Memory slice of the built-in route table (see
// `../builtins.ts`). All three are code-split behind `lazyRoute`, so the shell
// never imports them statically; each renders inside a Suspense boundary whose
// skeleton holds the page geometry while the chunk loads.

import { type ComponentProps, createElement, type ReactNode } from "react";
import { lazyRoute } from "../lazy-route.ts";
import type {
	ExactRouteRegistrar,
	PatternRouteRegistrar,
} from "./registrars.ts";
import {
	LIBRARY_SECTION,
	MEMORY_VIEW,
	STORE_SECTION,
} from "./route-patterns.ts";
import { withPageSkeleton } from "./route-skeleton.ts";

const StorePage = lazyRoute(() => import("@/src/pages/StorePage.tsx"));
const LibraryPage = lazyRoute(() => import("@/src/pages/LibraryPage.tsx"));
const MemoryDreamPage = lazyRoute(() =>
	import("@/src/components/memory/MemoryLibrary.tsx").then((module) => ({
		default: module.MemoryDreamPage,
	}))
);
const MemoryReflectPage = lazyRoute(() =>
	import("@/src/components/memory/MemoryLibrary.tsx").then((module) => ({
		default: module.MemoryReflectPage,
	}))
);

function store(props: ComponentProps<typeof StorePage> = {}): ReactNode {
	return withPageSkeleton(createElement(StorePage, props));
}

function library(props: ComponentProps<typeof LibraryPage> = {}): ReactNode {
	return withPageSkeleton(createElement(LibraryPage, props));
}

/** Exact Store and Library routes, including the legacy aliases that open them. */
export function registerStoreLibraryExactRoutes(
	exact: ExactRouteRegistrar
): void {
	// Agents/Spaces/Workflows no longer have standalone list pages — they're
	// consolidated into the unified Library; the bare routes redirect there.
	exact("/agents", () => library({ initialSection: "agent" }));
	exact("/engines", () => store({ initialSection: "engines" }));
	exact("/store", () => store());
	exact("/store/wallpapers", () => store({ initialSection: "wallpapers" }));
	// The plugin catalog's two slices: companion-UI apps vs plain plugins.
	exact("/store/apps", () => store({ initialSection: "apps" }));
	exact("/store/plugins", () => store({ initialSection: "plugins" }));
	exact("/store/agents", () => store({ initialSection: "agents" }));
	exact("/store/workflows", () => store({ initialSection: "workflows" }));
	exact("/store/integrations", () => store({ initialSection: "integrations" }));
	exact("/store/connections", () => store({ initialSection: "connections" }));
	exact("/library", () => library());
	exact("/library/wallpapers", () => library({ initialSection: "wallpapers" }));
	// Channels/Identities: bare routes open the Library collection tab; manage
	// CRUD lives on `/channels/:id`, `/channels/new`, `/identities/new`, and
	// `/identities/profile/:profileId` (profiles are named strings, not UUIDs).
	exact("/channels", () => library({ initialSection: "channel" }));
	exact("/identities", () => library({ initialSection: "identity" }));
	exact("/models", () => store({ initialSection: "models" }));
	exact("/skills", () => store({ initialSection: "skills" }));
	exact("/spaces", () => library({ initialSection: "space" }));
	// Tools moved from the Store to the Library — same bare route, new home. Kept as
	// `/tools` (not redirected to `/library/tools`) to match the other bare
	// collection routes (`/spaces`, `/workflows`) and so every existing sidebar
	// entry, palette command and deep link keeps working.
	exact("/tools", () => library({ initialSection: "tools" }));
	exact("/workflows", () => library({ initialSection: "workflow" }));
	// Marketplace folded into the store: the legacy route opens the store.
	exact("/marketplace/wallpapers", () =>
		store({ initialSection: "wallpapers" })
	);
	exact("/marketplace", (tab) =>
		store({
			initialMarketplaceItem: tab.initialStoreItem,
			initialMarketplaceQuery: tab.initialStoreQuery,
			initialSection:
				tab.initialStoreItem || tab.initialStoreQuery ? "browse" : undefined,
		})
	);
	// Apps + Extensions + Fleet all used to open the Store's "Added" section. That
	// section is gone — it was a tab that was not a category — and its view is now
	// the shell's "Installed only" switch over a real realm. Each legacy route
	// therefore opens the realm it actually meant, already narrowed to what is
	// installed, instead of one undifferentiated list.
	exact("/extensions", () =>
		store({
			initialInstalledOnly: true,
			initialSection: "plugins",
		})
	);
	exact("/apps", () =>
		store({
			initialInstalledOnly: true,
			initialSection: "apps",
		})
	);
	exact("/fleet", () =>
		store({
			initialInstalledOnly: true,
			initialSection: "apps",
		})
	);
}

/** `/store/mcp[/q/<query>]` and `/store/<section>`, in that order. */
export function registerStorePatternRoutes(
	pattern: PatternRouteRegistrar
): void {
	// /store/mcp and /store/mcp/q/<query> — open the store's MCP catalog,
	// optionally pre-filtered. The integrations.sh MCP hand-off deep-links here so
	// a directory entry lands on a real, installable registry match instead of an
	// external docs page (openTab strips `?`, so the query rides as a path segment).
	pattern(/^\/store\/mcp(?:\/q\/(.+))?$/, (tab) => {
		const match = tab.path.match(/^\/store\/mcp\/q\/(.+)$/);
		let query: string | undefined;
		if (match) {
			try {
				query = decodeURIComponent(match[1]);
			} catch {
				query = match[1];
			}
		}
		return store({
			initialSection: "mcp",
			initialQuery: query,
		});
	});
	// /store/<section> — every other Store section (skills, engines, models, the
	// legacy `account` alias, contributed `plugin:` tabs, …). StorePage resolves the
	// section itself and falls back to Home, so callers never land on a blank tab.
	pattern(STORE_SECTION, (tab) => {
		const match = tab.path.match(STORE_SECTION);
		return store({ initialSection: match?.[1] });
	});
}

/** The Memory deep links, then `/library/<section>`, in that order. */
export function registerLibraryPatternRoutes(
	pattern: PatternRouteRegistrar
): void {
	// /library/<section> — open the Library on a specific collection tab.
	pattern(MEMORY_VIEW, (tab) => {
		const view = tab.path.split("/")[3];
		return withPageSkeleton(
			createElement(view === "reflect" ? MemoryReflectPage : MemoryDreamPage)
		);
	});
	pattern(LIBRARY_SECTION, (tab) =>
		library({ initialSection: tab.path.split("/")[2] })
	);
}
