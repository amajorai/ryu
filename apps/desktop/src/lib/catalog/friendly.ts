// apps/desktop/src/lib/catalog/friendly.ts
//
// Pure, framework-free display helpers shared by the Models and Skills catalog
// tabs. The catalog surfaces raw developer data — dashed lowercase repo names
// (`gemma-4-E2B-it-GGUF`), cryptic quant labels (`Q4_K_M`), and param suffixes
// (`27B`, `a3b`, `e2b`). A non-developer can't read any of it. These helpers turn
// that into friendly names, Small/Medium/Large size badges, recognized-token
// badges (Instruct, Uncensored, Reasoning, …) and plain-language compression
// levels. Everything here is a single source of truth so both tabs and both
// toggle modes read the same vocabulary — no display logic is duplicated.
//
// Nothing here hits the network or React; it is exhaustively unit-tested in
// `friendly.test.ts`.

import type { ModelCard } from "@/src/lib/api/models.ts";
import type { SkillCard } from "@/src/lib/api/skills.ts";

/** Visual tone for a badge — maps to a Tailwind class set in the badge UI. */
export type BadgeTone =
	| "neutral"
	| "blue"
	| "violet"
	| "amber"
	| "rose"
	| "emerald";

/** A recognized name-token rendered as a labeled, filterable badge. */
export interface CatalogToken {
	/** Lowercase word aliases matched against name segments + tags. */
	aliases: string[];
	/** Stable filter id (also the badge key). */
	id: string;
	/** Human label shown on the badge. */
	label: string;
	tone: BadgeTone;
	/** Hover explanation. */
	tooltip: string;
}

/**
 * Token vocabulary, scanned against a model's name segments and its Hub tags.
 * Order matters only for display grouping; matching is alias-exact per segment.
 * Recognized segments are also stripped from the friendly name so the name reads
 * clean while the meaning survives as a badge.
 */
export const CATALOG_TOKENS: CatalogToken[] = [
	// Variant / training objective
	{
		id: "instruct",
		aliases: ["it", "instruct", "inst"],
		label: "Instruct",
		tooltip: "Instruction-tuned — follows chat-style prompts",
		tone: "blue",
	},
	{
		id: "chat",
		aliases: ["chat"],
		label: "Chat",
		tooltip: "Tuned for conversation",
		tone: "blue",
	},
	{
		id: "base",
		aliases: ["base", "pt", "pretrain", "pretrained"],
		label: "Base",
		tooltip: "Pretrained base model — not chat-tuned",
		tone: "neutral",
	},
	// Reasoning family
	{
		id: "reasoning",
		aliases: ["reasoning", "thinking", "think", "reason"],
		label: "Reasoning",
		tooltip: "Tuned to think step-by-step before answering",
		tone: "violet",
	},
	{
		id: "r1",
		aliases: ["r1"],
		label: "R1",
		tooltip: "DeepSeek-R1 style reasoning distillation",
		tone: "violet",
	},
	{
		id: "cot",
		aliases: ["cot"],
		label: "Chain-of-Thought",
		tooltip: "Trained to show its chain-of-thought reasoning",
		tone: "violet",
	},
	{
		id: "mtp",
		aliases: ["mtp"],
		label: "Multi-Token",
		tooltip: "Multi-token prediction — can decode faster",
		tone: "violet",
	},
	// Uncensored / alignment-removed
	{
		id: "uncensored",
		aliases: ["uncensored", "abliterated", "abliter", "unfiltered", "dolphin"],
		label: "Uncensored",
		tooltip: "Safety alignment reduced or removed (e.g. abliterated/Dolphin)",
		tone: "rose",
	},
	// Fine-tune / quant lineage
	{
		id: "qat",
		aliases: ["qat"],
		label: "Quality-Tuned",
		tooltip: "Quantization-aware training — keeps quality high when compressed",
		tone: "emerald",
	},
	{
		id: "finetuned",
		aliases: ["dpo", "sft", "rlhf", "orpo", "kto", "ft", "finetune"],
		label: "Fine-Tuned",
		tooltip: "Further fine-tuned (DPO/SFT/RLHF and similar)",
		tone: "emerald",
	},
	{
		id: "distilled",
		aliases: ["distill", "distilled", "distillation"],
		label: "Distilled",
		tooltip: "Distilled from a larger model — smaller, faster",
		tone: "emerald",
	},
	{
		id: "merged",
		aliases: ["merge", "merged", "slerp", "frankenmerge"],
		label: "Merged",
		tooltip: "A merge of several models",
		tone: "neutral",
	},
	// Modality
	{
		id: "vision",
		aliases: ["vl", "vision", "multimodal", "omni", "image"],
		label: "Vision",
		tooltip: "Understands images as well as text",
		tone: "blue",
	},
	// Domain
	{
		id: "coder",
		aliases: ["coder", "code", "codestral", "starcoder"],
		label: "Coder",
		tooltip: "Specialized for writing and understanding code",
		tone: "blue",
	},
	{
		id: "math",
		aliases: ["math", "maths", "mathstral"],
		label: "Math",
		tooltip: "Specialized for mathematical reasoning",
		tone: "blue",
	},
	// Architecture
	{
		id: "moe",
		aliases: ["moe"],
		label: "Mixture-of-Experts",
		tooltip: "Mixture-of-Experts — only part of the model runs per token",
		tone: "violet",
	},
	// Precision
	{
		id: "precision",
		aliases: ["fp16", "f16", "bf16", "fp32", "f32"],
		label: "Full precision",
		tooltip: "Uncompressed weights — highest quality, largest size",
		tone: "neutral",
	},
	// Format
	{
		id: "gguf",
		aliases: ["gguf", "ggml"],
		label: "GGUF",
		tooltip: "Local-friendly model file format",
		tone: "neutral",
	},
	{
		id: "format",
		aliases: ["onnx", "awq", "gptq", "exl2", "mlx", "safetensors"],
		label: "Other format",
		tooltip: "An alternate weight format",
		tone: "neutral",
	},
	// Stability
	{
		id: "preview",
		aliases: ["preview", "experimental", "beta", "alpha", "rc"],
		label: "Preview",
		tooltip: "Early / experimental release",
		tone: "amber",
	},
	// Context window
	{
		id: "longcontext",
		aliases: ["128k", "256k", "512k", "1m", "long", "longcontext"],
		label: "Long context",
		tooltip: "Handles unusually long inputs",
		tone: "blue",
	},
];

/**
 * Friendly-mode overrides per token: a simpler label for non-technical users,
 * or `hidden` to drop purely-technical badges entirely. Anything not listed
 * keeps its normal label in both modes (e.g. Chat, Vision, Coder, Math,
 * Uncensored, Reasoning, Preview, Long context all already read plainly).
 */
const TOKEN_FRIENDLY: Record<string, { label?: string; hidden?: boolean }> = {
	instruct: { label: "Chat-ready" },
	base: { label: "Raw" },
	moe: { label: "Efficient" },
	qat: { label: "High quality" },
	finetuned: { label: "Customized" },
	distilled: { label: "Compact" },
	// Jargon that collapses into the plain "Reasoning" badge.
	r1: { label: "Reasoning" },
	cot: { label: "Reasoning" },
	// Purely technical — noise for a non-developer.
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

/** Friendly compression level for a GGUF quant. */
export interface QuantInfo {
	/** Plain-language level (e.g. "Balanced (recommended)"). */
	label: string;
	/**
	 * Quality on a 1..{@link QUANT_QUALITY_MAX} scale, for the friendly meter
	 * ("more bars = better"). `null` when the quant is unknown — callers must omit
	 * the meter entirely in that case rather than render an empty (zero-quality)
	 * bar, which would read as a worse lie than the raw label.
	 */
	quality: number | null;
	/** Hover explanation, always including the raw quant. */
	tooltip: string;
}

/** Number of segments in the friendly quality meter. */
export const QUANT_QUALITY_MAX = 5;

// Split on dashes, underscores, slashes, whitespace, and dots — but NOT a dot
// sitting between two digits, so version numbers like "2.5" / "3.1" stay intact.
const SEPARATOR_RE = /[-_\s/]+|(?<!\d)\.|\.(?!\d)/;
// One param-size token: optional MoE prefix (a=active, e=effective), a number,
// and a B/M unit. Bounded so "v2b"-style noise and bare numbers don't match.
const SIZE_TOKEN_RE =
	/(?:^|[^a-z0-9])([ae]?)(\d+(?:\.\d+)?)([bm])(?![a-z0-9])/gi;

/** Lowercased non-empty segments of a name (split on -, _, ., /, space). */
function segments(text: string): string[] {
	return text
		.toLowerCase()
		.split(SEPARATOR_RE)
		.filter((s) => s.length > 0);
}

/** Build the set of every alias across the vocabulary, for fast name-stripping. */
const ALL_ALIASES = new Set<string>(CATALOG_TOKENS.flatMap((t) => t.aliases));

/**
 * Recognize tokens in a model's name + tags. Returns one {@link MatchedToken}
 * per distinct vocabulary entry that matched (deduped), in vocabulary order so
 * the badge row is stable.
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
 * (GGUF, format, precision, …) are dropped and the rest get simpler labels (with
 * the now-equal labels deduped, e.g. Reasoning + R1 + CoT → one "Reasoning").
 * In technical mode the tokens pass through untouched. Filtering/search still use
 * the raw {@link extractTokens} ids, so this only affects what's shown.
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
 * Parse the headline parameter size from a model name. Picks the largest token
 * (the total param count for an MoE like `30B-A3B`) as the headline tier, while
 * the tooltip lists every size token found so a knowledgeable user isn't misled
 * about active/effective params. Returns `null` when no size is present.
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
		const [, prefix, num, unit] = m;
		const b = billions(num, unit);
		descriptions.push(describeSizeToken(prefix, num, unit));
		// Prefer the largest magnitude; on a tie, prefer the dense (no-prefix) one.
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
// A whole segment that is just a param-size token (e.g. "27b", "a3b", "270m").
const STANDALONE_SIZE_RE = /^[ae]?\d+(?:\.\d+)?[bm]$/;

/** One friendly compression tier, matched against the uppercased quant string. */
interface QuantTier {
	blurb: string;
	label: string;
	/** 1..{@link QUANT_QUALITY_MAX} bars on the quality meter. */
	quality: number;
	test: RegExp;
}

// Quant-label families, in increasing quality. Order matters: the IQ (importance-
// matrix) families are tried before the plain K-quants. The `^IQ…` alternatives
// can't be stolen by `^Q…` since they start with "I", but listing IQ1/IQ2 first
// keeps the tiniest quants out of the broader "smallest" bucket.
const QUANT_TIERS: QuantTier[] = [
	{
		test: /^IQ[12]/,
		label: "Tiny",
		quality: 1,
		blurb:
			"Most compressed — smallest file and fastest, with the biggest quality loss vs this model's full version.",
	},
	{
		test: /^(Q[23]|IQ3)/,
		label: "Smallest",
		quality: 2,
		blurb:
			"Heavily compressed — small and fast, with noticeable quality loss vs this model's full version.",
	},
	{
		test: /^(Q4|IQ4)/,
		label: "Balanced (recommended)",
		quality: 3,
		blurb: "The best size-to-quality trade-off for most people.",
	},
	{
		test: /^Q[56]/,
		label: "High quality",
		quality: 4,
		blurb:
			"Lightly compressed — larger file, very close to this model's full version.",
	},
	{
		test: /^Q8/,
		label: "Near-original",
		quality: 5,
		blurb:
			"Barely compressed — nearly identical to this model's full version (size depends on the model, so this can still be small for a small model).",
	},
	{
		test: /^(F|BF)(16|32)/,
		label: "Full quality (largest)",
		quality: 5,
		blurb: "Uncompressed original weights — best quality, biggest download.",
	},
];

/** Title-case one already-cleaned segment, preserving versions and acronyms. */
function titleSegment(seg: string): string {
	// Short all-letter tokens that look like acronyms stay uppercase (e.g. "sd").
	if (ACRONYM_RE.test(seg)) {
		return seg.toUpperCase();
	}
	// Capitalize the first letter; keep the rest verbatim so versions like
	// "qwen2.5" → "Qwen2.5" and "v2" → "V2" survive unmangled.
	const i = seg.search(FIRST_LETTER_RE);
	if (i === -1) {
		return seg; // pure number / version, e.g. "3.1"
	}
	return seg.slice(0, i) + seg.charAt(i).toUpperCase() + seg.slice(i + 1);
}

/**
 * Friendly display name for any catalog entry: replace separators with spaces
 * and Title-Case each word. Used directly for skills (whose names are often
 * lowercase slugs) and as the final step of {@link friendlyModelName}.
 */
export function titleCase(raw: string): string {
	const parts = segments(raw).map(titleSegment);
	const joined = parts.join(" ").trim();
	return joined.length > 0 ? joined : raw;
}

/**
 * Friendly model name: strip every segment consumed by a recognized token or by
 * the size parser, then Title-Case the remainder. e.g. `gemma-4-E2B-it-GGUF` →
 * "Gemma 4" (with the dropped parts surfacing as Medium / Instruct / GGUF
 * badges). Falls back to a plain title-case of the original if nothing remains.
 */
export function friendlyModelName(name: string, _tags: string[] = []): string {
	const kept = segments(name).filter((seg) => {
		if (ALL_ALIASES.has(seg)) {
			return false;
		}
		// A standalone size token like "27b" / "a3b" / "270m".
		if (STANDALONE_SIZE_RE.test(seg)) {
			return false;
		}
		return true;
	});
	const joined = kept.map(titleSegment).join(" ").trim();
	return joined.length > 0 ? joined : titleCase(name);
}

/**
 * Plain-language compression level for a GGUF quant label (`Q4_K_M`, `Q8_0`,
 * `F16`, …). The raw label is always echoed in the tooltip so power users keep
 * the exact value. Unknown labels pass through unchanged.
 */
export function friendlyQuant(quant: string | null): QuantInfo {
	if (!quant) {
		// No parsed quant: be honest rather than show a meter we can't fill.
		return {
			label: "Custom",
			tooltip:
				"A custom or mixed quantization — the compression level varies across the file, so it can't be placed on the scale.",
			quality: null,
		};
	}
	const q = quant.toUpperCase();
	const raw = `Exact format: ${quant}`;
	for (const tier of QUANT_TIERS) {
		if (tier.test.test(q)) {
			return {
				label: tier.label,
				tooltip: `${tier.blurb} ${raw}`,
				quality: tier.quality,
			};
		}
	}
	// Unrecognized quant token: keep the raw label, no meter.
	return { label: quant, tooltip: raw, quality: null };
}

// A download label's `name (detail)` shape, e.g.
// "unsloth/gemma-4-12B-it-GGUF (gemma-4-12B-it-Q4_K_M.gguf)". The detail is the
// filename / quant / role that tells the user exactly what's being fetched, so
// it is never dropped — only the name half is made friendly.
const DOWNLOAD_LABEL_RE = /^(.*?)\s*\(([^)]*)\)\s*$/;
// A GGUF quant token anywhere in a filename: K-quant / IQ families, legacy
// Q4_0-style, or full-precision F16/BF16/F32. Top-level literal — never per call.
const QUANT_IN_FILENAME_RE = /\b(I?Q\d[\w]*|[FB]F?(?:16|32))\b/i;

/**
 * Friendly display name for a Download Center row. Only `model` and `skill`
 * downloads carry the cryptic developer strings a non-technical user can't read;
 * every other kind (engine/agent/tool/voice/media binaries) already has a clean
 * label and is returned untouched.
 *
 * For a model it splits the `name (detail)` shape, makes only the repo name
 * friendly ({@link friendlyModelName} on the last path segment), and maps a
 * quant-looking detail through {@link friendlyQuant} while keeping any other
 * detail verbatim. The detail is preserved either way so the user still knows
 * which file/quant is downloading. **Any parse miss or empty result falls back
 * to the raw label** — a friendly name is never worth losing information over.
 */
export function friendlyDownloadLabel(label: string, kind: string): string {
	if (kind === "skill") {
		const titled = titleCase(label);
		return titled.length > 0 ? titled : label;
	}
	if (kind !== "model") {
		return label;
	}

	const m = DOWNLOAD_LABEL_RE.exec(label);
	const namePart = (m ? m[1] : label).trim();
	const detail = m ? m[2].trim() : "";
	const lastSegment = namePart.split("/").pop() ?? namePart;
	const friendlyName = friendlyModelName(lastSegment);
	if (friendlyName.length === 0) {
		return label;
	}

	if (detail.length === 0) {
		return friendlyName;
	}
	const quantMatch = QUANT_IN_FILENAME_RE.exec(detail);
	const friendlyDetail = quantMatch
		? friendlyQuant(quantMatch[1]).label
		: detail;
	return `${friendlyName} · ${friendlyDetail}`;
}

/** A friendly, inline model display (for pickers/labels that have no badge row). */
export interface FriendlyModelDisplay {
	/** Friendly name plus " · <friendly compression>" when a quant is present. */
	label: string;
	/** Just the friendly model name (quant stripped) — compact, for a trigger. */
	name: string;
	/** The raw original string, surfaced verbatim in a hover tooltip. */
	original: string;
	/** Friendly compression info when the raw carried a quant token, else `null`. */
	quant: QuantInfo | null;
	/** Ready-to-show hover text: the original id plus the quant explanation. */
	tooltip: string;
}

/**
 * Friendly inline display for a single model name/id that may embed a quant
 * (`gemma-4-12B-it-Q4_K_M`, `unsloth/gemma-4-12B-it-GGUF`, a served-file stem, an
 * ACP-advertised name). Unlike the catalog — which renders the name and the quant
 * as separate elements (a clean name + a quality meter badge) — a picker or a
 * one-line label has nowhere to put a badge, so this folds the *same* vocabulary
 * (`friendlyModelName` + `friendlyQuant`, never a raw `Q4_K_M`) into one string
 * and keeps the raw original for a hover tooltip. Selection elsewhere is by id, so
 * the friendlier text is purely cosmetic.
 */
export function friendlyModelDisplay(raw: string): FriendlyModelDisplay {
	// Only the last path segment carries the model id ("org/repo" → "repo").
	const last = raw.split("/").pop() ?? raw;
	const quantMatch = QUANT_IN_FILENAME_RE.exec(last);
	const quant = quantMatch ? friendlyQuant(quantMatch[1]) : null;
	// Strip the quant token before friendly-naming so it isn't mangled into the
	// nonsense "Q4 K M" (the underscores split into separate, meaningless words).
	const withoutQuant = quantMatch ? last.replace(quantMatch[0], " ") : last;
	const name = friendlyModelName(withoutQuant);
	const label = quant ? `${name} · ${quant.label}` : name;
	const tooltip = quant ? `${raw}\n${quant.tooltip}` : raw;
	return { name, label, quant, original: raw, tooltip };
}

// Within one friendly quant tier, several GGUF variants collapse to the same
// word ("High quality" covers Q5_K_M, Q5_K_S, and Q6_K), so friendly mode shows
// one row per tier and hides the rest. These suffix patterns, in increasing
// rank, pick which variant is the canonical one to surface. `_K_M` ("medium")
// is the de-facto community-standard pick, then `_K_S`, `_K_L`, a bare `_K`,
// then the legacy `_0`/`_1` formats. Top-level literals — never built per call.
const QUANT_VARIANT_SUFFIXES: [RegExp, number][] = [
	[/_K_M$/, 0],
	[/_K_S$/, 1],
	[/_K_L$/, 2],
	[/_K$/, 3],
	[/_0$/, 4],
	[/_1$/, 5],
];

/**
 * Canonical-variant preference for one GGUF quant within its friendly tier —
 * LOWER is more canonical. Lets a caller choose the single variant to show per
 * tier (and which to hide behind a "show more" disclosure). Callers tie-break
 * equal ranks on device fit and file size. Returns a large number for anything
 * unrecognized (or a missing quant) so it sorts last.
 */
export function quantVariantRank(quant: string | null): number {
	if (!quant) {
		return 99;
	}
	const q = quant.toUpperCase();
	for (const [re, rank] of QUANT_VARIANT_SUFFIXES) {
		if (re.test(q)) {
			return rank;
		}
	}
	return 10;
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
 * multi-token-prediction / draft head (`MTP`, `draft`). These must not be shown
 * with a quality meter: a 93 MB "Near-original" `…-Q8_0-MTP.gguf` is a draft
 * head, not a small high-fidelity model, so labeling it as a quality tier is
 * misleading. Returns `null` for ordinary model quants.
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

// ── Search ──────────────────────────────────────────────────────────────────

/** Lowercased haystack for a model card: name, author, id, tags, token labels, size. */
export function modelHaystack(card: ModelCard): string {
	const tokens = extractTokens(card.name, card.tags).map((t) => t.label);
	const size = parseModelSize(card.name);
	return [
		card.name,
		friendlyModelName(card.name, card.tags),
		card.author,
		card.id,
		card.pipelineTag ?? "",
		...card.tags,
		...tokens,
		size?.raw ?? "",
		size?.tier ?? "",
	]
		.join(" ")
		.toLowerCase();
}

/** Lowercased haystack for a skill card: name, source/org, slug, id. */
export function skillHaystack(card: SkillCard): string {
	return [card.name, titleCase(card.name), card.source, card.slug, card.id]
		.join(" ")
		.toLowerCase();
}

const WHITESPACE_RE = /\s+/;

/** Whether a lowercased haystack contains every whitespace-separated term in `q`. */
export function matchesQuery(haystack: string, q: string): boolean {
	const terms = q.toLowerCase().trim().split(WHITESPACE_RE).filter(Boolean);
	return terms.every((t) => haystack.includes(t));
}

/** The org/owner of a skill id ("owner/repo/slug" → "owner"). */
export function skillOrg(card: SkillCard): string {
	return (card.source || card.id).split("/")[0] ?? "";
}

// ── Input/output modalities (from the HF pipeline tag) ──────────────────────

/** A data modality a model accepts or produces. */
export type Modality = "text" | "image" | "pdf" | "video" | "audio";

/** Canonical display order for modality icon rows. */
const MODALITY_ORDER: Modality[] = ["text", "image", "pdf", "video", "audio"];

/** What a model takes in and puts out, derived from its pipeline tag. */
export interface ModalityFlow {
	inputs: Modality[];
	outputs: Modality[];
}

/** Pipeline tags that don't follow the `<in>-to-<out>` shape. */
const FIXED_MODALITIES: Record<string, ModalityFlow> = {
	"text-generation": { inputs: ["text"], outputs: ["text"] },
	"text2text-generation": { inputs: ["text"], outputs: ["text"] },
	"fill-mask": { inputs: ["text"], outputs: ["text"] },
	summarization: { inputs: ["text"], outputs: ["text"] },
	translation: { inputs: ["text"], outputs: ["text"] },
	"question-answering": { inputs: ["text"], outputs: ["text"] },
	"table-question-answering": { inputs: ["text"], outputs: ["text"] },
	"feature-extraction": { inputs: ["text"], outputs: ["text"] },
	"sentence-similarity": { inputs: ["text"], outputs: ["text"] },
	"text-ranking": { inputs: ["text"], outputs: ["text"] },
	"text-classification": { inputs: ["text"], outputs: ["text"] },
	"token-classification": { inputs: ["text"], outputs: ["text"] },
	"zero-shot-classification": { inputs: ["text"], outputs: ["text"] },
	"automatic-speech-recognition": { inputs: ["audio"], outputs: ["text"] },
	"audio-classification": { inputs: ["audio"], outputs: ["text"] },
	"image-classification": { inputs: ["image"], outputs: ["text"] },
	"image-segmentation": { inputs: ["image"], outputs: ["text"] },
	"object-detection": { inputs: ["image"], outputs: ["text"] },
	"zero-shot-image-classification": { inputs: ["image"], outputs: ["text"] },
	"image-feature-extraction": { inputs: ["image"], outputs: ["text"] },
	"video-classification": { inputs: ["video"], outputs: ["text"] },
	"visual-question-answering": { inputs: ["text", "image"], outputs: ["text"] },
	"document-question-answering": {
		inputs: ["text", "pdf"],
		outputs: ["text"],
	},
};

/** Map one tag word to a modality (returns `null` for non-modality words). */
function wordToModality(word: string): Modality | null {
	switch (word) {
		case "text":
			return "text";
		case "image":
			return "image";
		case "audio":
		case "speech":
			return "audio";
		case "video":
			return "video";
		case "document":
		case "pdf":
			return "pdf";
		default:
			return null;
	}
}

/** Modalities named in one side of a pipeline tag (`any` → every modality). */
function segmentModalities(segment: string): Modality[] {
	if (segment === "any") {
		return [...MODALITY_ORDER];
	}
	const found = new Set<Modality>();
	for (const word of segment.split("-")) {
		const m = wordToModality(word);
		if (m) {
			found.add(m);
		}
	}
	return MODALITY_ORDER.filter((m) => found.has(m));
}

/**
 * Derive the input and output modalities from a Hugging Face `pipeline_tag`.
 * Handles the common `<in>-to-<out>` shape (`image-text-to-text`, `text-to-image`,
 * `any-to-any` → every modality both ways) plus a table of tags that don't use
 * that shape (`text-generation`, `automatic-speech-recognition`, …). Returns
 * `null` when the tag is missing or unrecognized, so callers can omit the row.
 */
export function parsePipelineModalities(
	pipelineTag: string | null
): ModalityFlow | null {
	if (!pipelineTag) {
		return null;
	}
	const tag = pipelineTag.toLowerCase().trim();
	const fixed = FIXED_MODALITIES[tag];
	if (fixed) {
		return fixed;
	}
	const idx = tag.indexOf("-to-");
	if (idx !== -1) {
		const inputs = segmentModalities(tag.slice(0, idx));
		const outputs = segmentModalities(tag.slice(idx + "-to-".length));
		if (inputs.length > 0 && outputs.length > 0) {
			return { inputs, outputs };
		}
	}
	return null;
}
