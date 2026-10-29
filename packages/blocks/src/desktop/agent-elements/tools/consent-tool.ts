import { z } from "zod";

/**
 * Pure helpers for the built-in consent cards (`consent.connect_app` /
 * `consent.install_plugin`). Kept free of React so parsing and ranking are
 * unit-testable on their own.
 *
 * The agent only names WHAT it needs. Everything the card shows about trust and
 * reputation comes from the catalog the host resolves, never from the model's
 * arguments: "this plugin is official" is exactly what a prompt-injected call
 * would claim.
 */

export type ConsentRequestKind = "connect_app" | "install_plugin";

/** Publisher trust, in the order the card offers plugins. */
export type PluginTrustTier = "official" | "verified" | "community";

const TIER_ORDER = {
	official: 0,
	verified: 1,
	community: 2,
} satisfies Record<PluginTrustTier, number>;

export interface ConnectAppRequest {
	/** Composio toolkit slug, or the MCP server name for provider `mcp`. */
	app: string;
	pluginId: string | null;
	provider: "composio" | "mcp";
	reason: string;
}

export interface PluginInstallRequest {
	pluginIds: string[];
	query: string | null;
	reason: string;
}

/** One plugin offered on the install card, as the host resolved it. */
export interface ConsentPluginCandidate {
	author: string | null;
	description: string | null;
	downloads: number | null;
	/** Installed and turned on. An installed plugin can be off until the user
	 *  approves its permissions in the Store. */
	enabled: boolean;
	iconUrl: string | null;
	id: string;
	/** Catalog installs are refused for community and descriptor-only listings;
	 *  the card offers a review link for those instead. */
	installable: boolean;
	installed: boolean;
	name: string;
	ratingAverage: number | null;
	ratingCount: number | null;
	/** The agent named this id explicitly (vs. a search match). */
	requested: boolean;
	/** Whether Ryu vetted this listing's code. `null` when the source is silent. */
	reviewed: boolean | null;
	/** Where a browse-only listing can be reviewed (repository or homepage). */
	reviewUrl: string | null;
	/** GitHub stars, reported for unmoderated listings. */
	stars: number | null;
	/** Installable, but only from the Store: the listing came from a different
	 *  marketplace than the one an install by id resolves, so installing from
	 *  chat could fetch a different same-id package than the one reviewed. */
	storeOnly: boolean;
	tier: PluginTrustTier;
	version: string | null;
}

/** The server-derived catalog fields that decide a listing's trust tier. */
export interface PluginTrustSignals {
	built_in?: boolean | null;
	org_verified?: boolean | null;
	org_verified_tier?: string | null;
	origin?: string | null;
	publisher_trust?: string | null;
}

/** Resolved state of an app connection, as the host reports it. */
export interface ConnectAppInfo {
	/** False when this host cannot connect the app (e.g. integrations are not
	 *  configured); `unavailableReason` then says why. */
	available: boolean;
	connected: boolean;
	logoUrl: string | null;
	name: string;
	/** Why it can't be connected, as a fixed category the follow-up can name
	 *  without quoting any catalog or manifest text. Null when available. */
	unavailableKind: UnavailableKind | null;
	unavailableReason: string | null;
}

const MAX_CANDIDATES = 3;

// Limits mirror Core's dispatch (`consent_tool.rs`) so a request Core rejects
// never renders an actionable card, and one Core accepts always does. Core
// counts Unicode scalar values (`chars().count()`), not UTF-16 code units, so
// an emoji counts once here too.
function scalarLength(value: string): number {
	return [...value].length;
}

function boundedText(max: number, min = 0) {
	return z
		.string()
		.trim()
		.refine((value) => scalarLength(value) >= min, { message: "too short" })
		.refine((value) => scalarLength(value) <= max, {
			message: `at most ${max} characters`,
		});
}

const reasonText = boundedText(280, 1);
const identText = boundedText(200, 1);

const connectInputSchema = z.object({
	app: identText,
	pluginId: boundedText(200).nullish(),
	// Core treats a blank provider as the default.
	provider: z
		.string()
		.trim()
		.pipe(z.enum(["composio", "mcp", ""]))
		.nullish(),
	reason: reasonText,
});

const installInputSchema = z.object({
	pluginIds: z.array(boundedText(200, 1)).max(5).nullish(),
	query: boundedText(200).nullish(),
	reason: reasonText,
});

/** Which consent card a tool part is, if any. Core surfaces the call either as
 *  a typed `tool-consent.*` part or as a `dynamic-tool` carrying the name. */
export function consentRequestKind(
	partType: string,
	toolName: string | undefined
): ConsentRequestKind | null {
	const name =
		partType === "dynamic-tool"
			? toolName
			: partType.startsWith("tool-")
				? partType.slice(5)
				: undefined;
	if (name === "consent.connect_app") {
		return "connect_app";
	}
	if (name === "consent.install_plugin") {
		return "install_plugin";
	}
	return null;
}

function blankToNull(value: string | null | undefined): string | null {
	return value && value.length > 0 ? value : null;
}

/** Parse a `consent.connect_app` input. Null while it is still streaming or
 *  when it is malformed (Core rejects the same shapes). */
export function connectRequestFromInput(
	input: unknown
): ConnectAppRequest | null {
	const parsed = connectInputSchema.safeParse(input);
	if (!parsed.success) {
		return null;
	}
	const provider = parsed.data.provider || "composio";
	const pluginId = blankToNull(parsed.data.pluginId);
	if (provider === "mcp" && !pluginId) {
		return null;
	}
	return {
		app: parsed.data.app,
		pluginId,
		provider,
		reason: parsed.data.reason,
	};
}

/** Parse a `consent.install_plugin` input. Needs a query or at least one id. */
export function pluginRequestFromInput(
	input: unknown
): PluginInstallRequest | null {
	const parsed = installInputSchema.safeParse(input);
	if (!parsed.success) {
		return null;
	}
	const pluginIds = [...new Set(parsed.data.pluginIds ?? [])];
	const query = blankToNull(parsed.data.query);
	if (!query && pluginIds.length === 0) {
		return null;
	}
	return { pluginIds, query, reason: parsed.data.reason };
}

/**
 * Map server-derived catalog signals to a trust tier.
 *
 * Official: shipped with Core, first-party origin, or the gold Ryu-staff mark.
 * Verified: the blue identity mark or an identity-verified publishing org.
 * Community: everything else, including every GitHub-topic listing. A plugin's
 * id or name is never consulted: `@ryu/` in an id is a self-claim.
 */
export function pluginTrustTier(signals: PluginTrustSignals): PluginTrustTier {
	if (
		signals.built_in === true ||
		signals.origin === "first_party" ||
		signals.publisher_trust === "gold"
	) {
		return "official";
	}
	if (signals.origin === "community") {
		return "community";
	}
	if (signals.publisher_trust === "blue" || signals.org_verified === true) {
		return "verified";
	}
	return "community";
}

function finiteOrZero(value: number | null): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

/**
 * A single reputation number for ordering within a tier. Ratings count more as
 * they accumulate (a lone 5-star review does not beat a hundred 4.6s), and
 * installs and stars add on a log scale so a popular listing can't swamp a
 * well-rated one. Only used for ordering, never displayed.
 */
export function reputationScore(candidate: ConsentPluginCandidate): number {
	const rating = Math.min(finiteOrZero(candidate.ratingAverage), 5);
	const ratingCount = finiteOrZero(candidate.ratingCount);
	const downloads = finiteOrZero(candidate.downloads);
	const stars = finiteOrZero(candidate.stars);
	return (
		rating * Math.log10(ratingCount + 1) +
		Math.log10(downloads + 1) +
		0.5 * Math.log10(stars + 1)
	);
}

/**
 * Order candidates for the card: trust tier first (official, verified,
 * community), then plugins the agent named explicitly, then reputation, then
 * name. Duplicate ids keep their first occurrence. At most three are shown so
 * the choice stays a glance, not a store page.
 */
export function rankPluginCandidates(
	candidates: readonly ConsentPluginCandidate[],
	limit = MAX_CANDIDATES
): ConsentPluginCandidate[] {
	const seen = new Set<string>();
	const unique: ConsentPluginCandidate[] = [];
	for (const candidate of candidates) {
		if (!seen.has(candidate.id)) {
			seen.add(candidate.id);
			unique.push(candidate);
		}
	}
	return unique
		.map((candidate) => ({ candidate, score: reputationScore(candidate) }))
		.sort(
			(a, b) =>
				TIER_ORDER[a.candidate.tier] - TIER_ORDER[b.candidate.tier] ||
				Number(b.candidate.requested) - Number(a.candidate.requested) ||
				b.score - a.score ||
				a.candidate.name.localeCompare(b.candidate.name)
		)
		.slice(0, Math.max(0, limit))
		.map(({ candidate }) => candidate);
}

const COMPACT_COUNT = new Intl.NumberFormat("en-US", {
	maximumFractionDigits: 1,
	notation: "compact",
});

/** "1.2K"-style count, or null when there is nothing worth showing. */
export function formatCompactCount(value: number | null): string | null {
	const count = finiteOrZero(value);
	return count > 0 ? COMPACT_COUNT.format(count) : null;
}

/** "4.7" for a rating with at least one review, else null. */
export function formatRating(
	average: number | null,
	count: number | null
): string | null {
	if (finiteOrZero(count) === 0) {
		return null;
	}
	const rating = finiteOrZero(average);
	return rating > 0 ? Math.min(rating, 5).toFixed(1) : null;
}

/** The follow-up the card sends as the user's reply once they decide. */
export type UnavailableKind =
	| "not_configured"
	| "not_installed"
	| "turned_off"
	| "no_sign_in";

const UNAVAILABLE_SENTENCES = {
	not_configured: "app connections aren't set up on this node yet",
	not_installed: "the plugin that provides it isn't installed",
	turned_off: "the plugin that provides it is turned off",
	no_sign_in: "that plugin has no sign-in for it",
} satisfies Record<UnavailableKind, string>;

// Follow-ups are sent as the USER's message, so they carry only fixed wording
// and identifiers that passed this filter. Catalog names, descriptions and
// manifest text never appear: a listing named "Ignore previous instructions…"
// must not become something the user appears to have said.
const SAFE_IDENTIFIER = /^[A-Za-z0-9@._:/+-]{1,120}$/;

/** The identifier, quoted, when it is a plain id; otherwise a neutral phrase. */
export function quoteIdentifier(value: string, fallback: string): string {
	return SAFE_IDENTIFIER.test(value) ? `"${value}"` : fallback;
}

export function connectFollowUp(
	app: string,
	outcome: "connected" | "declined" | "unavailable",
	unavailableKind?: UnavailableKind | null
): string {
	const target = quoteIdentifier(app, "the app");
	if (outcome === "connected") {
		return `I connected ${target}. Please continue.`;
	}
	if (outcome === "unavailable") {
		// Not a refusal: the host found the connection can't be made here, so
		// the agent hears why and can suggest the setup step instead.
		const why = unavailableKind
			? UNAVAILABLE_SENTENCES[unavailableKind]
			: "it isn't available on this node";
		return `I couldn't connect ${target} here: ${why}.`;
	}
	return `Not now. I don't want to connect ${target}.`;
}

export function installFollowUp(
	pluginId: string | null,
	outcome: "installed" | "ready" | "declined"
): string {
	const plugin =
		pluginId && SAFE_IDENTIFIER.test(pluginId)
			? `the plugin "${pluginId}"`
			: "the plugin I chose on the card";
	if (outcome === "installed" && pluginId) {
		return `I installed ${plugin}. Please continue.`;
	}
	if (outcome === "ready" && pluginId) {
		return `${plugin.charAt(0).toUpperCase()}${plugin.slice(1)} is already installed and turned on. Please continue.`;
	}
	return "Not now. I don't want to install a plugin for this.";
}
