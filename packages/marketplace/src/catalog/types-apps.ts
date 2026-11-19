// packages/marketplace/src/catalog/types-apps.ts
//
// Apps realm detail, sources, and the Apps section's injected hook state.
// Split out of `types.ts`, which re-exports everything here so existing import
// paths keep working.
//
// test-exempt: type-only declarations with no runtime behavior; `types.ts` re-exports them
// and the catalog section tests exercise them through that facade.

import type { VerificationDetails } from "@ryu/ui/components/verification-popover.tsx";
import type {
	PublisherTrustLevel,
	PublisherTrustSource,
} from "@ryuhq/protocol/publisher-trust";
import type { DesignSystemEvidence } from "./design-system-scorecard.ts";
import type {
	CatalogExtensionSummary,
	CatalogImplementationSummary,
	CatalogSurfaceSupport,
} from "./types-compatibility.ts";
import type { AppCatalogItem } from "./types-entry.ts";
import type { CatalogLayer } from "./types-layers.ts";
import type {
	CatalogApiSurface,
	CatalogPermissions,
	CatalogVersion,
} from "./types-listing-parts.ts";
import type {
	CatalogBanner,
	CatalogDeprecation,
} from "./types-presentation.ts";

/** One release train a listing publishes, and the version it currently resolves
 *  to.
 *
 *  `installable` is the load-bearing field: a train read from a repository's git
 *  tags describes what an author TAGGED and can be browsed, while only a train the
 *  marketplace serves can actually be installed. Rendering both as selectable
 *  would produce a picker whose choice silently does nothing. */
export interface CatalogChannel {
	channel: string;
	installable?: boolean;
	version?: string | null;
}

/** Registry detail for a browse-only integration descriptor. */
export interface PluginCatalogDetail {
	accentColor?: string | null;
	/** The manifest's API surface — what installing this adds. Absent when the
	 *  source could not read a manifest. */
	apiSurface?: CatalogApiSurface | null;
	/** True when the source repository is archived (it will not receive fixes). */
	archived?: boolean;
	author?: string | null;
	banner?: CatalogBanner | null;
	/** True for a Core-shipped system plugin. */
	builtIn?: boolean;
	capabilities?: string[];
	category?: string | null;
	/** First publication timestamp, when the source reports one. */
	createdAt?: string | null;
	/** Deprecation notice; see {@link CatalogDeprecation}. Absent = current. */
	deprecated?: CatalogDeprecation | null;
	description?: string | null;
	descriptor?: { url?: string | null } | null;
	/** True when the listing is discovery-only: no verified in-store install path,
	 *  so the CTA links out to the repository instead. */
	descriptorOnly?: boolean;
	/** Bounded UI source evidence for the optional Ryu design-system scorecard. */
	designSystem?: DesignSystemEvidence | null;
	developer?: string | null;
	/** True when the source repository is disabled upstream. */
	disabled?: boolean;
	/** Provenance of a community listing: which GitHub topic surfaced it, and the
	 *  repository it came from. camelCase because it rides on the DETAIL payload
	 *  (the card is snake_case — see the casing note on `CatalogEntry`). */
	discoveredFrom?: { repositoryUrl?: string | null; topic: string } | null;
	domain?: string | null;
	/** Total downloads across all published release assets. */
	downloads?: number | null;
	/** Minimum Ryu version this plugin declares. */
	engines?: { ryu?: string | null } | null;
	/** Why enrichment fell short (e.g. no manifest at the repository root). Drives
	 *  the health scan's "reads cleanly" check — surfaced, never swallowed. */
	enrichmentError?: string | null;
	examplePrompts?: string[];
	/** Existing host capabilities and shell slots this listing extends. */
	extensions?: CatalogExtensionSummary[];
	external?: boolean;
	feeds?: string[] | null;
	forks?: number | null;
	iconBackground?: string | null;
	iconUrl?: string | null;
	/** Where the feature is implemented: Core runtime, shared shell, or package
	 *  process. Display-only; it is not an execution route. */
	implementation?: CatalogImplementationSummary[];
	/** False when the upstream issue tracker is turned off. */
	issuesEnabled?: boolean;
	keywords?: string[];
	layers?: CatalogLayer[];
	license?: string | null;
	/** The plugin id the discovered repo's own manifest CLAIMS. Surfaced separately
	 *  from the entry id on purpose, so an id-squatting repo can never masquerade
	 *  as a plugin you already have installed. */
	manifestId?: string | null;
	/** Where the manifest was read from (a raw repository URL). */
	manifestUrl?: string | null;
	/** Server-derived A Major Pass inclusion marker for catalog presentation. */
	membershipIncluded?: boolean;
	/** Count of open issues upstream. */
	openIssues?: number | null;
	/** The PUBLISHING ORGANIZATION's identity is verified. camelCase because it
	 *  rides on the DETAIL payload (the card spells it
	 *  `org_verified`/`org_verified_tier` — see the casing note on
	 *  `discoveredFrom`).
	 *
	 *  Same three-axis warning as on the card: this is neither `reviewed` (did Ryu
	 *  vet this listing's CODE) nor the web marketplace's `verification` (did the
	 *  manifest SIGNATURE verify — install trust, and the field that already owns
	 *  the bare word `verified` on that wire). This one is only "do we know who the
	 *  publisher is". Server-derived, never self-asserted. */
	orgVerified?: boolean;
	/** The publishing org's verification tier ("official" | "partner" |
	 *  "community"). Plain string on purpose — an unknown tier renders the badge
	 *  unqualified rather than dropping it. */
	orgVerifiedTier?: string | null;
	/** Who listed this. `"community"` = automatic discovery, nobody vetted it. */
	origin?: string | null;
	/** Opaque permission-grant ids the plugin asks the Gateway to approve. */
	permissionGrants?: string[];
	/** The typed runtime permission set Core lowers into the sandbox. */
	permissions?: CatalogPermissions | null;
	privacyPolicyUrl?: string | null;
	/** Complete publisher identity mark when the detail source knows it. */
	publisherTrust?: PublisherTrustLevel | null;
	publisherTrustSource?: PublisherTrustSource | null;
	/** Public evidence behind the publisher mark, when the detail source provides it. */
	publisherVerification?: VerificationDetails | null;
	/** Long-form documentation (markdown) read from the plugin's README. */
	readme?: string | null;
	readmeUrl?: string | null;
	repositoryUrl?: string | null;
	/** Plugin-to-plugin dependencies, mirroring the manifest's `requires`. */
	requires?: {
		apps?: { id: string; min_version?: string | null }[];
		grants?: string[];
	} | null;
	/** False when nobody at Ryu vetted this listing. */
	reviewed?: boolean;
	runnables?: { id: string; kind: string; name?: string }[];
	screenshots?: string[];
	stars?: number | null;
	/** Host surfaces this plugin declares support for (desktop, island, mobile, …).
	 *  Empty/absent means it is offered everywhere — never read it as "nowhere".
	 *
	 *  Typed as plain `string[]`, deliberately: a manifest written against a newer
	 *  Ryu may name a surface this build has never heard of, and the catalog must
	 *  carry it through rather than drop it. Use {@link Surface} when you need the
	 *  known set (e.g. to exhaustively label them). */
	surfaceSupport?: CatalogSurfaceSupport[];
	surfaces?: string[];
	tagline?: string | null;
	tags?: string[];
	termsOfServiceUrl?: string | null;
	/** Last upstream activity (a push or a release). */
	updatedAt?: string | null;
	url?: string | null;
	version?: string | null;
	/** Published version history, newest first. */
	versions?: CatalogVersion[] | null;
	watchers?: number | null;
	website?: string | null;
}

/** A selectable catalog source (Ryu Marketplace, integrations.sh, custom). */
export interface PluginCatalogSource {
	displayName: string;
	id: string;
}

/** Params to add a custom Claude plugin marketplace as a source. */
export interface AddMarketplaceParams {
	baseUrl: string;
	displayName: string;
	id: string;
}

/** One-step movement within the custom marketplace order. */
export type MarketplaceMoveDirection = "up" | "down";

/** What the Apps section consumes from its injected data hook. */
export interface AppsCatalogState {
	activeSource: string;
	addingMarketplace: boolean;
	addMarketplace: (params: AddMarketplaceParams) => Promise<void>;
	detail: PluginCatalogDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	hasNextPage: boolean;
	/** Add a listing. A card passes its own id; the detail panel may omit it and
	 *  act on the current selection.
	 *
	 *  `options.channel` installs from a prerelease train instead of the stable
	 *  release, and the node PERSISTS that choice — the listing keeps following the
	 *  train on later updates rather than being pulled back to stable. */
	install: (
		id?: string,
		options?: { channel?: string | null }
	) => Promise<void>;
	installFromUrl: (url: string) => Promise<void>;
	/** The id whose add is in flight, or null. Carries identity on purpose: as a
	 *  bare boolean it followed the SELECTION, so the spinner moved to whatever
	 *  listing the user opened next. Matches `SkillsCatalogState.installing`. */
	installing: string | null;
	/** Error from the manual manifest URL install action, shown beside its field. */
	installUrlError?: string | null;
	/** Install or update one exact historical version from the Versions tab. */
	installVersion?: (id: string, version: CatalogVersion) => Promise<void>;
	items: AppCatalogItem[];
	lifecyclePending: boolean;
	loading: boolean;
	loadingMore: boolean;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectedItem: AppCatalogItem | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setEnabled: (enabled: boolean) => Promise<void>;
	setQuery: (q: string) => void;
	sources: PluginCatalogSource[];
	/** Move an INSTALLED listing onto another release train, and to that train's
	 *  current build. `null` returns it to stable.
	 *
	 *  A distinct verb from `install` on purpose: switching is an update of
	 *  something already present, and it can move the install BACKWARDS (every
	 *  prerelease sorts below its stable release), which an install path has no
	 *  business doing silently. Optional — a host with no update seam omits it and
	 *  the switch control never renders. */
	switchChannel?: (id: string, channel: string | null) => Promise<void>;
}
