/**
 * Ryu's first-party capability taxonomy (Treg parity B1).
 *
 * This is the TypeScript twin of the Rust contract
 * `ryu_gw_contracts::capability_taxonomy`. Both read the same data,
 * `crates/gateway/contracts/fixtures/capability-taxonomy-v1.json`, and assert
 * the same golden cases, `capability-taxonomy-cases-v1.json`. A rule change
 * lands as a fixture case first, then in both implementations.
 *
 * A capability is a job an agent wants done (`web.search`, `issue.create`); a
 * platform is the real-world system the job acts on (`web`, `github`). An
 * endpoint joins one capability on one platform, and `(platform, capability)`
 * is the comparison row that lines up every vendor serving the same job.
 *
 * - Propose, then promote: only `promoted` capabilities key a comparison row;
 *   a `retired` one names a non-retired `successor`.
 * - No duplicate meaning: ids, aliases, facade verbs and descriptions are
 *   unique, and names that reduce to the same words are refused.
 * - Per-model generative media: a `per_model` capability's key carries the
 *   model id; a capability-level row must not carry one.
 *
 * Every function is pure. Errors carry fixed codes and the offending id only.
 */

import { z } from "zod";
import taxonomyJson from "../../../crates/gateway/contracts/fixtures/capability-taxonomy-v1.json" with {
	type: "json",
};

/** Version of this contract and of `capability-taxonomy-v1.json`. */
export const TAXONOMY_VERSION = 1 as const;

/** Maximum length of a capability or platform id. */
export const TAXONOMY_MAX_ID_LEN = 64;

/** Maximum length of a model id in a per-model comparison key. */
export const TAXONOMY_MAX_MODEL_LEN = 128;

const STOP_WORDS = new Set([
	"a",
	"an",
	"and",
	"at",
	"by",
	"for",
	"from",
	"in",
	"into",
	"of",
	"on",
	"or",
	"the",
	"to",
	"with",
]);

const CAPABILITY_SEGMENT = /^[a-z][a-z0-9_]*$/;
const PLATFORM_ID = /^[a-z][a-z0-9-]*$/;
const MODEL_ID = /^[A-Za-z0-9._:/-]+$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NON_ALPHANUMERIC = /[^a-z0-9]+/;
const ASCII_UPPER = /[A-Z]/g;
const SIBILANT_PLURALS = ["sses", "ches", "shes", "xes", "zes"] as const;

const statusSchema = z.enum(["proposed", "promoted", "retired"]);
const comparisonSchema = z.enum(["capability", "per_model"]);

const platformSchema = z.strictObject({
	addedOn: z.string(),
	description: z.string(),
	id: z.string(),
	name: z.string(),
	status: statusSchema,
});

const capabilitySchema = z.strictObject({
	addedOn: z.string(),
	aliases: z.array(z.string()).default(() => []),
	comparison: comparisonSchema,
	description: z.string(),
	id: z.string(),
	layer: z.string().optional(),
	name: z.string(),
	platforms: z.array(z.string()),
	status: statusSchema,
	successor: z.string().optional(),
	verbs: z.array(z.string()).default(() => []),
});

const taxonomySchema = z.strictObject({
	capabilities: z.array(capabilitySchema),
	description: z.string(),
	platforms: z.array(platformSchema),
	version: z.int().nonnegative(),
});

export type TaxonomyStatus = z.infer<typeof statusSchema>;
export type ComparisonRule = z.infer<typeof comparisonSchema>;
export type Platform = z.infer<typeof platformSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type Taxonomy = z.infer<typeof taxonomySchema>;

/** One validation finding: a fixed code and the id it concerns. */
export interface TaxonomyIssue {
	code: string;
	subject: string;
}

/** Why a `(platform, capability, model)` triple has no comparison key. */
export type ComparisonError =
	| "unknown_capability"
	| "platform_not_allowed"
	| "model_required"
	| "model_not_allowed"
	| "invalid_model"
	| "capability_retired"
	| "capability_not_promoted";

export type ComparisonResult =
	| { key: string; ok: true }
	| { error: ComparisonError; ok: false };

/** Decode a taxonomy document without validating its rules. */
export const decodeTaxonomy = (value: unknown): Taxonomy =>
	taxonomySchema.parse(value);

/** `<segment>(.<segment>)+`, each segment `[a-z][a-z0-9_]*`. */
export const isValidCapabilityId = (id: string): boolean => {
	if (id.length === 0 || id.length > TAXONOMY_MAX_ID_LEN) {
		return false;
	}
	const segments = id.split(".");
	return (
		segments.length >= 2 &&
		segments.every((segment) => CAPABILITY_SEGMENT.test(segment))
	);
};

/** `[a-z][a-z0-9-]*`. */
export const isValidPlatformId = (id: string): boolean =>
	id.length <= TAXONOMY_MAX_ID_LEN && PLATFORM_ID.test(id);

/** 1..=128 characters of `[A-Za-z0-9._:/-]`. */
export const isValidModelId = (model: string): boolean =>
	model.length <= TAXONOMY_MAX_MODEL_LEN && MODEL_ID.test(model);

/** A calendar date written `YYYY-MM-DD` (1970 or later). */
export const isValidIsoDate = (value: string): boolean => {
	const match = ISO_DATE.exec(value);
	if (!match) {
		return false;
	}
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (year < 1970 || month < 1 || month > 12 || day < 1) {
		return false;
	}
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const daysInMonth = [
		31,
		leap ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31,
	];
	return day <= (daysInMonth[month - 1] ?? 0);
};

const lowerAscii = (value: string): string =>
	value.replace(ASCII_UPPER, (letter) => letter.toLowerCase());

/** A naive English singular, matching the Rust `singular`. */
const singular = (word: string): string => {
	if (word.length > 4 && word.endsWith("ies")) {
		return `${word.slice(0, -3)}y`;
	}
	for (const suffix of SIBILANT_PLURALS) {
		if (word.endsWith(suffix)) {
			return word.slice(0, -2);
		}
	}
	if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) {
		return word.slice(0, -1);
	}
	return word;
};

/**
 * The words a capability name reduces to for the duplicate-meaning check:
 * lowercase ASCII words of two or more letters, stop words dropped, plurals
 * made singular, deduplicated and sorted. Empty when nothing is left.
 */
export const meaningKey = (name: string): string => {
	const words = new Set<string>();
	for (const word of lowerAscii(name).split(NON_ALPHANUMERIC)) {
		if (word.length >= 2 && !STOP_WORDS.has(word)) {
			words.add(singular(word));
		}
	}
	return [...words].sort().join(" ");
};

/** Every issue in `taxonomy`, in discovery order. Empty means valid. */
export const validateTaxonomy = (taxonomy: Taxonomy): TaxonomyIssue[] => {
	const issues: TaxonomyIssue[] = [];
	const push = (code: string, subject: string) => {
		issues.push({ code, subject });
	};
	if (taxonomy.version !== TAXONOMY_VERSION) {
		push("unsupported_version", String(taxonomy.version));
		return issues;
	}

	const platformIds = new Set<string>();
	for (const platform of taxonomy.platforms) {
		if (!isValidPlatformId(platform.id)) {
			push("invalid_platform_id", platform.id);
		}
		if (platformIds.has(platform.id)) {
			push("duplicate_platform", platform.id);
		}
		platformIds.add(platform.id);
		if (platform.name.trim() === "" || platform.description.trim() === "") {
			push("empty_text", platform.id);
		}
		if (!isValidIsoDate(platform.addedOn)) {
			push("invalid_date", platform.id);
		}
	}

	const ids = new Set<string>();
	const verbs = new Set<string>();
	const meanings = new Set<string>();
	const descriptions = new Set<string>();
	for (const capability of taxonomy.capabilities) {
		const { id } = capability;
		if (!isValidCapabilityId(id)) {
			push("invalid_id", id);
		}
		if (ids.has(id)) {
			push("duplicate_id", id);
		}
		ids.add(id);
		if (capability.name.trim() === "" || capability.description.trim() === "") {
			push("empty_text", id);
		}
		if (!isValidIsoDate(capability.addedOn)) {
			push("invalid_date", id);
		}
		if (capability.platforms.length === 0) {
			push("no_platforms", id);
		}
		if (capability.platforms.some((platform) => !platformIds.has(platform))) {
			push("unknown_platform", id);
		}
		if (capability.verbs.length > 0 && capability.status !== "promoted") {
			push("verb_not_promoted", id);
		}
		for (const verb of capability.verbs) {
			if (verbs.has(verb)) {
				push("duplicate_verb", verb);
			}
			verbs.add(verb);
		}
		if (capability.status === "retired" && capability.successor === undefined) {
			push("missing_successor", id);
		}
		if (capability.status !== "retired" && capability.successor !== undefined) {
			push("successor_not_allowed", id);
		}
		const meaning = meaningKey(capability.name);
		if (meaning !== "") {
			if (meanings.has(meaning)) {
				push("duplicate_meaning", id);
			}
			meanings.add(meaning);
		}
		const description = lowerAscii(capability.description.trim());
		if (description !== "") {
			if (descriptions.has(description)) {
				push("duplicate_description", id);
			}
			descriptions.add(description);
		}
	}

	const byId = new Map<string, Capability>();
	for (const capability of taxonomy.capabilities) {
		if (!byId.has(capability.id)) {
			byId.set(capability.id, capability);
		}
	}
	const aliases = new Set<string>();
	for (const capability of taxonomy.capabilities) {
		for (const alias of capability.aliases) {
			if (!isValidCapabilityId(alias)) {
				push("invalid_id", alias);
			}
			if (byId.has(alias) || aliases.has(alias)) {
				push("duplicate_alias", alias);
			}
			aliases.add(alias);
		}
		if (capability.status === "retired" && capability.successor !== undefined) {
			const next = byId.get(capability.successor);
			const valid =
				capability.successor !== capability.id &&
				next !== undefined &&
				next.status !== "retired";
			if (!valid) {
				push("invalid_successor", capability.id);
			}
		}
	}
	return issues;
};

/** Decode and validate a taxonomy document; throws on the first issue. */
export const parseTaxonomy = (value: unknown): Taxonomy => {
	const taxonomy = decodeTaxonomy(value);
	const [first, ...rest] = validateTaxonomy(taxonomy);
	if (first) {
		throw new Error(
			`taxonomy invalid: ${first.code} (${first.subject}), ${rest.length + 1} issue(s)`
		);
	}
	return taxonomy;
};

/** The capability `id` names, directly or through an alias. */
export const resolveCapability = (
	taxonomy: Taxonomy,
	id: string
): Capability | undefined =>
	taxonomy.capabilities.find((capability) => capability.id === id) ??
	taxonomy.capabilities.find((capability) => capability.aliases.includes(id));

/** The capability that owns facade verb `verb`. */
export const capabilityForVerb = (
	taxonomy: Taxonomy,
	verb: string
): Capability | undefined =>
	taxonomy.capabilities.find((capability) => capability.verbs.includes(verb));

const modelProblem = (
	rule: ComparisonRule,
	model: string | null | undefined
): ComparisonError | null => {
	if (rule === "capability") {
		return model === null || model === undefined ? null : "model_not_allowed";
	}
	if (model === null || model === undefined || model === "") {
		return "model_required";
	}
	return isValidModelId(model) ? null : "invalid_model";
};

/**
 * The comparison-row key for an endpoint: `<platform>/<capability>`, or
 * `<platform>/<capability>@<model>` for a per-model capability. Aliases key
 * their canonical row. Only promoted capabilities are compared.
 */
export const comparisonKey = (
	taxonomy: Taxonomy,
	platform: string,
	capability: string,
	model?: string | null
): ComparisonResult => {
	const found = resolveCapability(taxonomy, capability);
	if (!found) {
		return { error: "unknown_capability", ok: false };
	}
	if (!found.platforms.includes(platform)) {
		return { error: "platform_not_allowed", ok: false };
	}
	const problem = modelProblem(found.comparison, model);
	if (problem) {
		return { error: problem, ok: false };
	}
	if (found.status === "retired") {
		return { error: "capability_retired", ok: false };
	}
	if (found.status === "proposed") {
		return { error: "capability_not_promoted", ok: false };
	}
	const base = `${platform}/${found.id}`;
	return {
		key: found.comparison === "per_model" ? `${base}@${model}` : base,
		ok: true,
	};
};

/** The built-in taxonomy, decoded and validated at module load. */
export const BUILTIN_TAXONOMY: Taxonomy = parseTaxonomy(taxonomyJson);
