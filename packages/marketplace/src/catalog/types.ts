// packages/marketplace/src/catalog/types.ts
//
// Structural item + hook-state types for the shared catalog sections. These
// declare ONLY the fields the moved components actually read — pass-through /
// unread fields on the desktop hooks (e.g. AppCatalogItem.info) are intentionally
// omitted so a surface's real hook result stays structurally assignable without
// this package importing anything from apps/desktop. Desktop passes its concrete
// hook results (which carry a superset of these fields); web passes an adapter
// that fabricates exactly these fields from its federated catalog data.

// ---------------------------------------------------------------------------
// Apps (plugins) realm
// ---------------------------------------------------------------------------

/** Presentational banner descriptor for an app's hero region. */
export interface CatalogBanner {
	colors: string[];
	seed?: number;
	style?: "gradient" | "dither";
}

/** One catalog entry as the Apps section reads it. */
export interface CatalogEntry {
	accent_color?: string | null;
	banner?: CatalogBanner | null;
	built_in?: boolean;
	/** Ids of separate plugins this app ships as a logical bundle (install/uninstall together). */
	bundles?: string[] | null;
	category?: string | null;
	description: string;
	descriptor_only?: boolean;
	developer?: string | null;
	icon_background?: string | null;
	icon_url?: string | null;
	id: string;
	integration_kind?: string | null;
	integration_url?: string | null;
	kinds: string[];
	name: string;
	source?: string;
	tagline?: string | null;
	tags: string[];
	version?: string;
}

/** A catalog entry joined with its live lifecycle state (installed/enabled). */
export interface AppCatalogItem {
	enabled: boolean;
	entry: CatalogEntry;
	grants: string[];
	installed: boolean;
}

/** Registry detail for a browse-only integration descriptor. */
export interface PluginCatalogDetail {
	accentColor?: string | null;
	banner?: CatalogBanner | null;
	bundles?: string[] | null;
	capabilities?: string[];
	category?: string | null;
	descriptor?: { url?: string | null } | null;
	developer?: string | null;
	domain?: string | null;
	examplePrompts?: string[];
	feeds?: string[] | null;
	iconBackground?: string | null;
	iconUrl?: string | null;
	keywords?: string[];
	license?: string | null;
	privacyPolicyUrl?: string | null;
	runnables?: { id: string; kind: string; name?: string }[];
	screenshots?: string[];
	tagline?: string | null;
	termsOfServiceUrl?: string | null;
	url?: string | null;
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

// ---------------------------------------------------------------------------
// Skills realm
// ---------------------------------------------------------------------------

/** A Skill row in the left-hand selector, as the Skills section reads it. */
export interface SkillCard {
	downloads?: number;
	id: string;
	installed: boolean;
	installs: number;
	name: string;
	slug: string;
	source: string;
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

/** One selectable skills catalog source (skills.sh + custom marketplaces). */
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
	install: () => Promise<void>;
	installFromUrl: (url: string) => Promise<void>;
	installing: boolean;
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
}

// ---------------------------------------------------------------------------
// Models realm
//
// Structural subsets of the desktop model-catalog types (apps/desktop/src/lib/
// api/models.ts + useModelCatalog). They declare ONLY the fields the Models
// section reads, so the desktop concrete hook result (a superset) stays
// structurally assignable when injected through the host, and web fabricates
// exactly these fields from its federated catalog.
// ---------------------------------------------------------------------------

/** How the catalog list is ordered. */
export type ModelSort = "trending" | "downloads" | "likes" | "recent";

/** Model weight format (which engine family can serve it). */
export type ModelFormat = "gguf" | "safetensors" | "mlx";

/** Friendly model category shown in the task filter. */
export type ModelCategory =
	| "all"
	| "chat"
	| "vision"
	| "embedding"
	| "reranker"
	| "stt"
	| "tts";

/** Plain-language device-fit verdict, worst → best. */
export type FitVerdict =
	| "too_big"
	| "cpu"
	| "partial"
	| "ok"
	| "great"
	| "unknown";

/** One selectable model catalog source (Hugging Face + mirrors). */
export interface ModelCatalogSource {
	displayName: string;
	id: string;
}

/** A model row in the left-hand selector / detail header. */
export interface ModelCard {
	architecture: string | null;
	author: string;
	compatible: boolean;
	contextLength: number | null;
	createdAt: string | null;
	downloads: number;
	format: ModelFormat;
	gated: boolean;
	id: string;
	installed: boolean;
	lastModified: string | null;
	likes: number;
	name: string;
	needsEngine: string | null;
	params: number | null;
	pipelineTag: string | null;
	tags: string[];
}

/** One downloadable file of a model (a GGUF quantization). */
export interface ModelFile {
	filename: string;
	fit: FitVerdict;
	fitLabel: string;
	installed: boolean;
	quant: string | null;
	sizeBytes: number | null;
	sizeHuman: string;
}

/** Independent benchmark stats from Artificial Analysis (when available). */
export interface AaStats {
	intelligenceIndex: number | null;
	matchedName: string;
	outputTokensPerSecond: number | null;
	priceUsdPer1m: number | null;
	timeToFirstTokenS: number | null;
}

/** Detected hardware the fit verdicts were computed against. */
export interface DeviceInfo {
	gpuName: string | null;
	os: string;
	ramHuman: string;
	unifiedMemory: boolean;
	vramBytes: number | null;
	vramHuman: string;
}

/** Full right-hand detail payload for a selected model. */
export interface ModelDetail {
	card: ModelCard;
	device: DeviceInfo;
	files: ModelFile[];
	format: ModelFormat;
	readme: string | null;
	repoFitLabel: string;
	repoSizeBytes: number | null;
	stats: AaStats | null;
	statsApiKeyPresent: boolean;
	vision: boolean;
}

/** One installed model by local stem; `finetuneBase` set only for merged fine-tunes. */
export interface InstalledModelEntry {
	finetuneBase: string | null;
	stem: string;
}

/** On-demand llmfit hardware fit + tok/s estimate for one model. */
export interface LlmFitEstimate {
	fit_level: string | null;
	installed: boolean;
	matched: boolean;
	min_vram_gb: number | null;
	path: string | null;
	tps: number | null;
}

/** What the Models section consumes from its injected data hook. */
export interface ModelCatalogState {
	activeSource: string;
	browseOrg: (o: string) => void;
	category: ModelCategory;
	detail: ModelDetail | null;
	detailError: string | null;
	detailLoading: boolean;
	error: string | null;
	fetchNextPage: () => void;
	format: ModelFormat;
	hasNextPage: boolean;
	install: (file: string) => Promise<void>;
	installedOnly: boolean;
	installing: string | null;
	installingSnapshot: boolean;
	installSnapshot: () => Promise<void>;
	loading: boolean;
	loadingMore: boolean;
	models: ModelCard[];
	org: string;
	query: string;
	select: (id: string) => void;
	selectedId: string | null;
	selectingSource: boolean;
	selectSource: (id: string) => void;
	setCategory: (c: ModelCategory) => void;
	setFormat: (f: ModelFormat) => void;
	setInstalledOnly: (v: boolean) => void;
	setOrg: (o: string) => void;
	setQuery: (q: string) => void;
	setSort: (s: ModelSort) => void;
	sort: ModelSort;
	sources: ModelCatalogSource[];
	uninstall: (file: string) => Promise<void>;
	uninstalling: string | null;
}
