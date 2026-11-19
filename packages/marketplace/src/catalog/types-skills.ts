// packages/marketplace/src/catalog/types-skills.ts
//
// Skills realm cards, detail, sources, and the Skills section's hook state.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.
//
// test-exempt: type-only declarations with no runtime behavior; `types.ts` re-exports them
// and the catalog section tests exercise them through that facade.

import type {
	AddMarketplaceParams,
	MarketplaceMoveDirection,
} from "./types-apps.ts";

// ---------------------------------------------------------------------------
// Skills realm
// ---------------------------------------------------------------------------

/** A Skill row in the left-hand selector, as the Skills section reads it. */
export interface SkillCard {
	/** Marketplace stamp added by Core in the all-marketplaces view. */
	catalogSourceId?: string | null;
	catalogSourceName?: string | null;
	/** One-line "what this does". Present for INSTALLED cards (read from the
	 *  on-disk SKILL.md front matter) and on the detail card; absent for a browse
	 *  result, because skills.sh's search payload carries no description. Cards
	 *  fall back to the source + install count when it is missing. */
	description?: string | null;
	downloads?: number;
	id: string;
	installed: boolean;
	installs: number;
	name: string;
	slug: string;
	source: string;
	/** Registry-level trust claim: builtin, trusted, or community. */
	trustLevel?: string | null;
}

/** A file inside a Skill package. */
export interface SkillFile {
	contents?: string;
	path: string;
}

/** One security audit row shown in the skill detail metadata grid. */
export interface SkillAudit {
	audited_at?: string | null;
	name: string;
	risk_level?: string | null;
	status: string;
	summary?: string | null;
	url: string | null;
}

/** The metadata block for a selected skill. Always an object (never null) — the
 *  detail panel dereferences its fields unconditionally, so a read-only surface
 *  fabricates this with null fields + an empty `securityAudits` array. */
export interface SkillDetailMetadata {
	firstSeen: string | null;
	githubCreatedAt: string | null;
	githubPushedAt: string | null;
	githubStars: string | null;
	githubUpdatedAt: string | null;
	installs: string | null;
	repositoryUrl: string | null;
	securityAudits: SkillAudit[];
}

/** Full right-hand detail payload for a selected Skill. */
export interface SkillDetail {
	card: SkillCard;
	description: string | null;
	files: SkillFile[];
	metadata: SkillDetailMetadata;
	readme: string | null;
	url: string;
}

/** One selectable skills catalog source (registries + custom marketplaces). */
export interface SkillCatalogSource {
	baseUrl?: string | null;
	builtin?: boolean;
	displayName: string;
	id: string;
}

/** Sort order for the skills list. */
export type SkillSort = "popular" | "name";

/** What the Skills section consumes from its injected data hook. The unread
 *  `installedSkills` field on the desktop hook is intentionally omitted — the
 *  section reads only the derived `enabledByKey`. */
export interface SkillsCatalogState {
	activeSource: string;
	addingMarketplace: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: SkillDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	/** Enabled (active) state keyed by installed skill id/slug. */
	enabledByKey: Record<string, boolean>;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	install: () => Promise<void>;
	installedOnly: boolean;
	/** Id of the skill whose install is in flight, or `null`. */
	installing: string | null;
	loading: boolean;
	org: string;
	query: string;
	removeMarketplace: (id: string) => Promise<void>;
	reorderMarketplace: (
		id: string,
		direction: MarketplaceMoveDirection
	) => Promise<void>;
	select: (id: string) => void;
	selectedId: string | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	setSkillEnabled: (id: string, active: boolean) => Promise<void>;
	setSort: (s: SkillSort) => void;
	skills: SkillCard[];
	sort: SkillSort;
	sources: SkillCatalogSource[];
	/** Id of the skill whose enable/disable toggle is in flight, or `null`. */
	togglingSkill: string | null;
}
