// Store section metadata + path→section mapping for the unified Store surface.
// Pure data (no JSX), mirroring apps/desktop StorePage's SECTIONS / isStoreSection
// and the store-wide search realms. The Store shell (index.tsx) reads these to
// render the section tab-row, decide the initial section from a tab path, and drive
// the aggregated store search.

import type { ApiTarget } from "@ryuhq/core-client/client";
import { featureListLoader, type ListRow } from "../../core/featureList.ts";

/** One entry in the store tab-row. Order matches apps/desktop StorePage. */
export type StoreSection =
	| "apps"
	| "models"
	| "skills"
	| "mcp"
	| "agents"
	| "engines"
	| "finetune";

export interface SectionMeta {
	id: StoreSection;
	label: string;
}

// Desktop order: Plugins, Models, Skills, MCP, Agents, Engines, Fine-tune.
export const STORE_SECTIONS: SectionMeta[] = [
	{ id: "apps", label: "Plugins" },
	{ id: "models", label: "Models" },
	{ id: "skills", label: "Skills" },
	{ id: "mcp", label: "MCP" },
	{ id: "agents", label: "Agents" },
	{ id: "engines", label: "Engines" },
	{ id: "finetune", label: "Fine-tune" },
];

// Maps a path segment to the section it lands on. Covers both the /store/<section>
// deep links and the standalone paths Integrate points at this surface
// (/models, /skills, /engines, /finetune).
const SECTION_BY_SEGMENT: Record<string, StoreSection> = {
	store: "apps",
	plugins: "apps",
	apps: "apps",
	models: "models",
	skills: "skills",
	mcp: "mcp",
	tools: "mcp",
	agents: "agents",
	engines: "engines",
	finetune: "finetune",
	"fine-tune": "finetune",
};

/** Decide the initial section for a tab path (the deepest recognized segment wins,
 * so /store/models lands on Models and /store defaults to Plugins). */
export function sectionFromPath(path: string): StoreSection {
	const segments = path.split("/").filter(Boolean);
	for (let i = segments.length - 1; i >= 0; i--) {
		const match = SECTION_BY_SEGMENT[segments[i]];
		if (match) {
			return match;
		}
	}
	return "apps";
}

/** A searchable store realm: a section id + the loader that fetches its catalog.
 * The loaders compose the shared featureListLoader (no new fetch logic) so the
 * store-wide search reuses the exact endpoints the section tabs read. */
export interface SearchRealm {
	id: StoreSection;
	label: string;
	load: (target: ApiTarget, signal?: AbortSignal) => Promise<ListRow[]>;
}

export const SEARCH_REALMS: SearchRealm[] = [
	{
		id: "apps",
		label: "Plugins",
		load: featureListLoader({
			path: "/api/catalog",
			containerKeys: ["sidecars"],
			titleKeys: ["name"],
			subtitleKeys: ["category"],
			badgeKeys: ["install_state"],
			idKeys: ["name"],
		}),
	},
	{
		id: "models",
		label: "Models",
		load: featureListLoader({
			path: "/api/models/catalog?limit=30",
			containerKeys: ["data", "models", "items", "results"],
			titleKeys: ["name", "id", "model_id", "slug"],
			subtitleKeys: ["description", "author", "pipeline_tag"],
			badgeKeys: ["downloads", "installs", "likes"],
			idKeys: ["id", "model_id", "slug"],
		}),
	},
	{
		id: "skills",
		label: "Skills",
		load: featureListLoader({
			path: "/api/skills/catalog?limit=30",
			containerKeys: ["skills", "data", "results"],
			titleKeys: ["name", "slug", "id"],
			subtitleKeys: ["description", "summary"],
			badgeKeys: ["installed"],
			idKeys: ["id", "slug"],
		}),
	},
	{
		id: "mcp",
		label: "MCP",
		load: featureListLoader({
			path: "/api/tools/search?limit=30",
			containerKeys: ["data", "tools", "results"],
			titleKeys: ["name", "id"],
			subtitleKeys: ["description"],
			badgeKeys: ["kind"],
			idKeys: ["id"],
		}),
	},
];
