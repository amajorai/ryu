// apps/desktop/src/lib/api/skills.ts
//
// Typed client for Core's skills-catalog endpoints (`/api/skills/catalog*`).
// Browse and install Agent Skills from the public skills.sh directory. ALL logic
// (search, featured ranking, install into ~/.ryu/skills, installed detection)
// lives in Core over the public no-key skills.sh endpoints — this module only
// shapes requests and parses responses, so desktop/mobile/extension reuse it.

import {
	ApiError,
	type ApiTarget,
	buyerTokenHeader,
	request,
} from "./client.ts";

/** A Skill row in the left-hand selector. */
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

export interface SkillAudit {
	audited_at?: string | null;
	name: string;
	risk_level?: string | null;
	status: string;
	summary?: string | null;
	url: string | null;
}

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

interface CardWire {
	downloads?: number;
	id: string;
	installed?: boolean;
	installs?: number;
	name?: string;
	slug?: string;
	source?: string;
}

function toCard(w: CardWire): SkillCard {
	return {
		id: w.id,
		source: w.source ?? "",
		slug: w.slug ?? "",
		name: w.name ?? w.slug ?? w.id,
		installs: w.installs ?? 0,
		downloads: w.downloads ?? w.installs ?? 0,
		installed: w.installed ?? false,
	};
}

export interface SkillSearchParams {
	installedOnly?: boolean;
	limit?: number;
	query?: string;
}

/** Search/browse the skills directory. Core does ranking + installed lookup. */
export async function searchSkills(
	target: ApiTarget,
	params: SkillSearchParams = {}
): Promise<SkillCard[]> {
	const q = new URLSearchParams();
	if (params.query) {
		q.set("query", params.query);
	}
	if (params.limit) {
		q.set("limit", String(params.limit));
	}
	if (params.installedOnly) {
		q.set("installed_only", "true");
	}
	const json = await request<{ skills?: CardWire[] }>(
		target,
		`/api/skills/catalog?${q.toString()}`
	);
	return (json.skills ?? []).map(toCard);
}

/** Fetch a Skill's detail (SKILL.md docs, description, file list). */
export async function fetchSkillDetail(
	target: ApiTarget,
	id: string
): Promise<SkillDetail> {
	const json = await request<{
		card: CardWire;
		description?: string | null;
		readme?: string | null;
		files?: SkillFile[];
		metadata?: {
			first_seen?: string | null;
			github_created_at?: string | null;
			github_pushed_at?: string | null;
			github_stars?: string | null;
			github_updated_at?: string | null;
			installs?: string | null;
			repository_url?: string | null;
			security_audits?: SkillAudit[];
		};
		url?: string;
	}>(target, `/api/skills/catalog/detail?id=${encodeURIComponent(id)}`);
	const metadata = json.metadata ?? {};
	return {
		card: toCard(json.card),
		description: json.description ?? null,
		readme: json.readme ?? null,
		files: json.files ?? [],
		metadata: {
			firstSeen: metadata.first_seen ?? null,
			githubCreatedAt: metadata.github_created_at ?? null,
			githubPushedAt: metadata.github_pushed_at ?? null,
			githubStars: metadata.github_stars ?? null,
			githubUpdatedAt: metadata.github_updated_at ?? null,
			installs: metadata.installs ?? null,
			repositoryUrl: metadata.repository_url ?? null,
			securityAudits: metadata.security_audits ?? [],
		},
		url: json.url ?? "",
	};
}

export interface SkillAgentTarget {
	detected: boolean;
	featured: boolean;
	globalSkillsDir: string | null;
	id: string;
	name: string;
	projectSkillsDir: string;
	resolvedGlobalPath: string | null;
	selectable: boolean;
	unavailableReason: string | null;
}

export interface SkillInstallPreferences {
	configured: boolean;
	targetIds: string[];
	version: 1;
}

export interface SkillTargetsSnapshot {
	droppedTargetIds: string[];
	preferences: SkillInstallPreferences;
	targets: SkillAgentTarget[];
	warning: string | null;
}

export type SkillDistributionStatus =
	| "copied"
	| "current"
	| "conflict"
	| "failed";

export interface SkillDistributionTargetResult {
	message: string | null;
	path: string | null;
	status: SkillDistributionStatus;
	targetId: string;
}

export interface SkillDistributionResult {
	skillId: string;
	targets: SkillDistributionTargetResult[];
}

export interface SkillInstallOptions {
	promptForTargets?: boolean;
	rememberTargetIds?: boolean;
	targetIds?: string[];
}

export interface SkillTargetChoice {
	remember: boolean;
	targetIds: string[];
}

export interface SkillInstallResult {
	distribution: SkillDistributionResult | null;
	path: string;
	slug: string;
}

export class SkillTargetsRequiredError extends Error {
	constructor() {
		super("Choose default agents on this computer.");
		this.name = "SkillTargetsRequiredError";
	}
}

export async function fetchSkillTargets(
	target: ApiTarget
): Promise<SkillTargetsSnapshot> {
	return request(target, "/api/skills/targets");
}

export async function saveSkillTargetPreferences(
	target: ApiTarget,
	targetIds: string[]
): Promise<SkillTargetsSnapshot> {
	return request(target, "/api/skills/targets/preferences", {
		method: "PUT",
		body: { targetIds },
	});
}

export async function resetSkillTargetPreferences(
	target: ApiTarget
): Promise<SkillTargetsSnapshot> {
	return request(target, "/api/skills/targets/preferences", {
		method: "DELETE",
	});
}

export async function distributeSkill(
	target: ApiTarget,
	skillId: string,
	choice: SkillTargetChoice
): Promise<SkillDistributionResult> {
	const json = await request<{
		distribution?: SkillDistributionResult;
		error?: string;
		success?: boolean;
	}>(target, `/api/skills/${encodeURIComponent(skillId)}/distribute`, {
		method: "POST",
		body: {
			targetIds: choice.targetIds,
			rememberTargetIds: choice.remember,
		},
	});
	if (json.success === false || !json.distribution) {
		throw new Error(json.error ?? `Failed to distribute ${skillId}`);
	}
	return json.distribution;
}

/** Install a Skill into ~/.ryu/skills and hot-reload Core's skill registry. */
export async function installSkill(
	target: ApiTarget,
	id: string,
	source?: string,
	options: SkillInstallOptions = {}
): Promise<SkillInstallResult> {
	let json: {
		distribution?: SkillDistributionResult;
		error?: string;
		result?: { path: string; slug: string };
		success?: boolean;
	};
	try {
		json = await request(target, "/api/skills/catalog/install", {
			method: "POST",
			body: {
				id,
				...(source ? { source } : {}),
				...options,
			},
			// Forward the buyer's control-plane session so a PAID marketplace item's
			// entitlement check (#491) can resolve the org + license. Free items ignore it.
			headers: buyerTokenHeader(target),
		});
	} catch (error) {
		if (
			error instanceof ApiError &&
			error.status === 409 &&
			error.serverMessage === "skill_targets_required"
		) {
			throw new SkillTargetsRequiredError();
		}
		throw error;
	}
	if (json.success === false || !json.result) {
		throw new Error(json.error ?? `Failed to install ${id}`);
	}
	return {
		slug: json.result.slug,
		path: json.result.path,
		distribution: json.distribution ?? null,
	};
}

// ── Installed skills + enable/disable (activation) ────────────────────────────
//
// Distinct from the catalog (browse/install): these list the skills already on
// disk and toggle their *active* state. Core gates injection on the active set
// (`POST /api/skills/activate`), so disabling a skill stops it being injected
// into any chat without uninstalling it.

/** An installed skill with its current enabled (active) state. */
export interface InstalledSkill {
	allowedTools: string[];
	description: string | null;
	enabled: boolean;
	id: string;
	name: string;
}

interface InstalledSkillWire {
	allowed_tools?: string[];
	description?: string | null;
	enabled?: boolean;
	id: string;
	name?: string;
}

/** List the installed skills (enabled + disabled) with their active state. */
export async function listSkills(target: ApiTarget): Promise<InstalledSkill[]> {
	const json = await request<{ skills?: InstalledSkillWire[] }>(
		target,
		"/api/skills"
	);
	return (json.skills ?? []).map((s) => ({
		id: s.id,
		name: s.name ?? s.id,
		description: s.description ?? null,
		enabled: s.enabled ?? false,
		allowedTools: s.allowed_tools ?? [],
	}));
}

/** Enable or disable an installed skill (toggles its injection eligibility). */
export async function setSkillActive(
	target: ApiTarget,
	id: string,
	active: boolean
): Promise<void> {
	await request<{ success?: boolean }>(target, "/api/skills/activate", {
		method: "POST",
		body: { id, active },
	});
}

// ── Catalog sources (#463) ───────────────────────────────────────────────────
//
// The Skills catalog is backed by a swappable source: skills.sh by default, or a
// custom Claude plugin marketplace (a repo/URL hosting a
// `.claude-plugin/marketplace.json`). The active source lives in Core; the
// dropdown lists them and selects one, after which the skills list re-keys.

/** One selectable skills catalog source. Mirrors Core's source descriptor. */
export interface SkillCatalogSource {
	baseUrl: string | null;
	builtin: boolean;
	displayName: string;
	id: string;
}

interface SkillSourceWire {
	base_url?: string | null;
	builtin?: boolean;
	display_name: string;
	id: string;
}

/** The active source id plus every source available for the skill kind. */
export interface SkillCatalogSources {
	active: string;
	sources: SkillCatalogSource[];
}

function toSkillSource(w: SkillSourceWire): SkillCatalogSource {
	return {
		id: w.id,
		displayName: w.display_name,
		builtin: w.builtin ?? false,
		baseUrl: w.base_url ?? null,
	};
}

/** List the skill catalog sources and which one is active. */
export async function fetchSkillSources(
	target: ApiTarget
): Promise<SkillCatalogSources> {
	const json = await request<{
		active?: string;
		sources?: SkillSourceWire[];
	}>(target, "/api/catalog/sources?kind=skill");
	return {
		active: json.active ?? "",
		sources: (json.sources ?? []).map(toSkillSource),
	};
}

/** Select the active skill catalog source by id. */
export async function selectSkillSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	await request<unknown>(target, "/api/catalog/sources/select", {
		method: "POST",
		body: { kind: "skill", id },
	});
}

/** Parameters for adding a custom Claude plugin marketplace as a skill source. */
export interface AddMarketplaceParams {
	baseUrl: string;
	displayName: string;
	id: string;
}

/** Add a custom Claude plugin marketplace (repo/URL with marketplace.json). */
export async function addMarketplaceSource(
	target: ApiTarget,
	params: AddMarketplaceParams
): Promise<void> {
	const json = await request<{ ok?: boolean; error?: string }>(
		target,
		"/api/catalog/sources",
		{
			method: "POST",
			body: {
				kind: "skill",
				id: params.id,
				display_name: params.displayName,
				base_url: params.baseUrl,
			},
		}
	);
	if (json.ok === false) {
		throw new Error(json.error ?? "Failed to add marketplace");
	}
}

/** Remove a custom skill marketplace. Built-in registries are rejected by Core. */
export async function removeMarketplaceSource(
	target: ApiTarget,
	id: string
): Promise<void> {
	const json = await request<{ ok?: boolean; error?: string }>(
		target,
		"/api/catalog/sources",
		{
			method: "DELETE",
			body: { kind: "skill", id },
		}
	);
	if (json.ok === false) {
		throw new Error(json.error ?? "Failed to remove marketplace");
	}
}

export type MarketplaceMoveDirection = "up" | "down";

/** Move a custom skill marketplace one position in the marketplace list. */
export async function reorderMarketplaceSource(
	target: ApiTarget,
	id: string,
	direction: MarketplaceMoveDirection
): Promise<void> {
	const json = await request<{ ok?: boolean; error?: string }>(
		target,
		"/api/catalog/sources/reorder",
		{
			method: "POST",
			body: { kind: "skill", id, direction },
		}
	);
	if (json.ok === false) {
		throw new Error(json.error ?? "Failed to reorder marketplace");
	}
}
