// packages/marketplace/src/catalog/friendly.ts
//
// Pure, framework-free display helpers for the shared catalog badges
// (chrome/catalog-badges.tsx) and the Models and Skills catalog sections. This is
// the single implementation of the catalog vocabulary: the desktop
// `apps/desktop/src/lib/catalog/friendly.ts` re-exports it and adds only its
// desktop-only surfaces (Download Center labels, model pickers, search
// haystacks). Nothing here hits the network or React.

import { type BadgeTone, CATALOG_TOKENS } from "./friendly-tokens.ts";
import type { SkillCard } from "./types.ts";

export type { Modality, ModalityFlow } from "./friendly-modalities.ts";
export { parsePipelineModalities } from "./friendly-modalities.ts";
export type { QuantInfo } from "./friendly-quant.ts";
export {
	friendlyQuant,
	QUANT_QUALITY_MAX,
	quantVariantRank,
} from "./friendly-quant.ts";
export type { BadgeTone, CatalogToken } from "./friendly-tokens.ts";
export { CATALOG_TOKENS } from "./friendly-tokens.ts";

/**
 * Friendly-mode overrides per token: a simpler label for non-technical users, or
 * `hidden` to drop purely-technical badges entirely.
 */
interface FriendlyTokenPresentation {
	hidden?: boolean;
	label?: string;
}

/** Vocabulary overrides are optional for tokens supplied by newer catalogs. */
interface FriendlyTokenOverrides {
	[tokenId: string]: FriendlyTokenPresentation | undefined;
}

const TOKEN_FRIENDLY: FriendlyTokenOverrides = {
	instruct: { label: "Chat-ready" },
	base: { label: "Raw" },
	moe: { label: "Efficient" },
	qat: { label: "High quality" },
	finetuned: { label: "Customized" },
	distilled: { label: "Compact" },
	r1: { label: "Reasoning" },
	cot: { label: "Reasoning" },
	mtp: { hidden: true },
	merged: { hidden: true },
	gguf: { hidden: true },
	format: { hidden: true },
	precision: { hidden: true },
};

/** A token matched on a specific card, ready to render. */
export interface MatchedToken {
	id: string;
	label: string;
	tone: BadgeTone;
	tooltip: string;
}

/** Friendly size badge: a tier word plus the literal param count for the hover. */
export interface SizeBadgeInfo {
	/** Raw token shown in raw mode and always in the tooltip (e.g. "27B"). */
	raw: string;
	/** Tier word shown in friendly mode (e.g. "Large"). */
	tier: string;
	/** Full hover explanation (notes active/effective params for MoE). */
	tooltip: string;
}

// Split on dashes, underscores, slashes, whitespace, and dots — but NOT a dot
// sitting between two digits, so version numbers like "2.5" / "3.1" stay intact.
const SEPARATOR_RE = /[-_\s/]+|(?<!\d)\.|\.(?!\d)/;
// One param-size token: optional MoE prefix (a=active, e=effective), a number,
// and a B/M unit.
const SIZE_TOKEN_RE =
	/(?:^|[^a-z0-9])([ae]?)(\d+(?:\.\d+)?)([bm])(?![a-z0-9])/gi;

/** Lowercased non-empty segments of a name (split on -, _, ., /, space). */
function segments(text: string): string[] {
	return text
		.toLowerCase()
		.split(SEPARATOR_RE)
		.filter((s) => s.length > 0);
}

// These exact filename tokens identify GGUF files that are not standalone
// model weights. Keep this separate from the role labels below: an importance
// matrix is an input to quantization, not an add-on that a user can run.
const NON_MODEL_GGUF_SEGMENTS = new Set(["draft", "imatrix", "mmproj", "mtp"]);

/** Whether a GGUF filename represents a selectable model-weight quant. */
export function isModelGgufFile(filename: string): boolean {
	const segs = new Set(segments(filename));
	for (const segment of NON_MODEL_GGUF_SEGMENTS) {
		if (segs.has(segment)) {
			return false;
		}
	}
	return true;
}

/**
 * Recognize tokens in a model's name + tags. Returns one {@link MatchedToken} per
 * distinct vocabulary entry that matched (deduped), in vocabulary order.
 */
export function extractTokens(
	name: string,
	tags: string[] = []
): MatchedToken[] {
	const haystack = new Set<string>(segments(name));
	for (const tag of tags) {
		for (const seg of segments(tag)) {
			haystack.add(seg);
		}
	}
	const out: MatchedToken[] = [];
	for (const token of CATALOG_TOKENS) {
		if (token.aliases.some((a) => haystack.has(a))) {
			out.push({
				id: token.id,
				label: token.label,
				tooltip: token.tooltip,
				tone: token.tone,
			});
		}
	}
	return out;
}

/**
 * Resolve matched tokens for display. In friendly mode, purely-technical badges
 * are dropped and the rest get simpler labels (deduped); in technical mode they
 * pass through untouched.
 */
export function displayTokens(
	tokens: MatchedToken[],
	friendly: boolean
): MatchedToken[] {
	if (!friendly) {
		return tokens;
	}
	const seen = new Set<string>();
	const out: MatchedToken[] = [];
	for (const t of tokens) {
		const meta = TOKEN_FRIENDLY[t.id];
		if (meta?.hidden) {
			continue;
		}
		const label = meta?.label ?? t.label;
		if (seen.has(label)) {
			continue;
		}
		seen.add(label);
		out.push(label === t.label ? t : { ...t, label });
	}
	return out;
}

/** Human description of one size token for the hover. */
function describeSizeToken(prefix: string, num: string, unit: string): string {
	const count =
		unit.toLowerCase() === "m" ? `${num} million` : `${num} billion`;
	if (prefix.toLowerCase() === "a") {
		return `${num}${unit.toUpperCase()} active parameters (Mixture-of-Experts)`;
	}
	if (prefix.toLowerCase() === "e") {
		return `${num}${unit.toUpperCase()} effective parameters`;
	}
	return `${count} parameters`;
}

/** Billions-equivalent magnitude of a size token, for tier comparison. */
function billions(num: string, unit: string): number {
	const n = Number.parseFloat(num);
	return unit.toLowerCase() === "m" ? n / 1000 : n;
}

/** Tier word for a billions-equivalent param count. */
function tierFor(b: number): string {
	if (b < 3) {
		return "Small";
	}
	if (b < 20) {
		return "Medium";
	}
	if (b < 70) {
		return "Large";
	}
	return "Extra Large";
}

/**
 * Parse the headline parameter size from a model name. Picks the largest token as
 * the headline tier while the tooltip lists every size token found. Returns `null`
 * when no size is present.
 */
export function parseModelSize(name: string): SizeBadgeInfo | null {
	const matches = [...name.matchAll(SIZE_TOKEN_RE)];
	if (matches.length === 0) {
		return null;
	}
	let headline: {
		prefix: string;
		num: string;
		unit: string;
		b: number;
	} | null = null;
	const descriptions: string[] = [];
	for (const m of matches) {
		const [, prefixRaw, num, unit] = m;
		// `([ae]?)` always captures (possibly ""), and `(\d+…)([bm])` only match
		// together, so num/unit are present whenever this loop runs — the guard is
		// only here to satisfy `noUncheckedIndexedAccess`.
		if (num === undefined || unit === undefined) {
			continue;
		}
		const prefix = prefixRaw ?? "";
		const b = billions(num, unit);
		descriptions.push(describeSizeToken(prefix, num, unit));
		if (
			!headline ||
			b > headline.b ||
			(b === headline.b && prefix === "" && headline.prefix !== "")
		) {
			headline = { prefix, num, unit, b };
		}
	}
	if (!headline) {
		return null;
	}
	const raw = `${headline.prefix.toUpperCase()}${headline.num}${headline.unit.toUpperCase()}`;
	return {
		tier: tierFor(headline.b),
		raw,
		tooltip: descriptions.join(" · "),
	};
}

const ACRONYM_RE = /^[a-z]{1,3}$/;
const FIRST_LETTER_RE = /[a-z]/i;

/** Title-case one already-cleaned segment, preserving versions and acronyms. */
function titleSegment(seg: string): string {
	if (ACRONYM_RE.test(seg)) {
		return seg.toUpperCase();
	}
	const i = seg.search(FIRST_LETTER_RE);
	if (i === -1) {
		return seg;
	}
	return seg.slice(0, i) + seg.charAt(i).toUpperCase() + seg.slice(i + 1);
}

/**
 * Friendly display name for any catalog entry: replace separators with spaces and
 * Title-Case each word. Used directly for skills (whose names are often lowercase
 * slugs).
 */
export function titleCase(raw: string): string {
	const parts = segments(raw).map(titleSegment);
	const joined = parts.join(" ").trim();
	return joined.length > 0 ? joined : raw;
}

/** The org/owner of a skill id ("owner/repo/slug" → "owner"). */
export function skillOrg(card: SkillCard): string {
	return (card.source || card.id).split("/")[0] ?? "";
}

// Every alias across the token vocabulary, for stripping consumed segments from
// a friendly model name.
const ALL_ALIASES = new Set<string>(CATALOG_TOKENS.flatMap((t) => t.aliases));

// A whole segment that is just a param-size token (e.g. "27b", "a3b", "270m").
const STANDALONE_SIZE_RE = /^[ae]?\d+(?:\.\d+)?[bm]$/;

/**
 * Friendly model name: strip every segment consumed by a recognized token or by
 * the size parser, then Title-Case the remainder. e.g. `gemma-4-E2B-it-GGUF` →
 * "Gemma 4". Falls back to a plain title-case of the original if nothing remains.
 */
export function friendlyModelName(name: string, _tags: string[] = []): string {
	const kept = segments(name).filter((seg) => {
		if (ALL_ALIASES.has(seg)) {
			return false;
		}
		if (STANDALONE_SIZE_RE.test(seg)) {
			return false;
		}
		return true;
	});
	const joined = kept.map(titleSegment).join(" ").trim();
	return joined.length > 0 ? joined : titleCase(name);
}

/** A non-quant role for a GGUF file that pairs with a base model. */
export interface GgufRole {
	/** Short label (e.g. "Vision adapter"). */
	label: string;
	/** Hover explanation. */
	tooltip: string;
}

/**
 * Classify a GGUF file that is *not* a quantization of the main model but an
 * auxiliary component that pairs with one — a vision adapter (`mmproj`) or a
 * multi-token-prediction / draft head. Returns `null` for ordinary model quants.
 */
export function ggufFileRole(filename: string): GgufRole | null {
	const segs = new Set(segments(filename));
	if (segs.has("mmproj")) {
		return {
			label: "Vision adapter",
			tooltip:
				"An image-understanding add-on (mmproj). Download it alongside a model quant — it isn't a standalone model.",
		};
	}
	if (segs.has("mtp")) {
		return {
			label: "Draft head (MTP)",
			tooltip:
				"An optional multi-token-prediction head that can speed up a paired base quant. Not a standalone model.",
		};
	}
	if (segs.has("draft")) {
		return {
			label: "Draft model",
			tooltip:
				"A small companion model used to speed up a larger one (speculative decoding). Not the main model.",
		};
	}
	return null;
}
