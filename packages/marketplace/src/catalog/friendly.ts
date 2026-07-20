// packages/marketplace/src/catalog/friendly.ts
//
// Pure, framework-free display helpers needed by the shared catalog badges
// (chrome/catalog-badges.tsx) and the Skills catalog section. This is a SUBSET of
// the desktop `apps/desktop/src/lib/catalog/friendly.ts` — only the badge/token/
// size helpers those two moved surfaces reference, plus the skills-specific
// `skillOrg` / `titleCase`. The desktop file stays the source of truth for the
// model-catalog surfaces (Download Center, model pickers, ModelsCatalogSection)
// that still live in the app; the Models decomposition follow-on consolidates the
// two into this one. Nothing here hits the network or React.

import type { SkillCard } from "./types.ts";

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
 */
export const CATALOG_TOKENS: CatalogToken[] = [
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
	{
		id: "uncensored",
		aliases: ["uncensored", "abliterated", "abliter", "unfiltered", "dolphin"],
		label: "Uncensored",
		tooltip: "Safety alignment reduced or removed (e.g. abliterated/Dolphin)",
		tone: "rose",
	},
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
	{
		id: "vision",
		aliases: ["vl", "vision", "multimodal", "omni", "image"],
		label: "Vision",
		tooltip: "Understands images as well as text",
		tone: "blue",
	},
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
	{
		id: "moe",
		aliases: ["moe"],
		label: "Mixture-of-Experts",
		tooltip: "Mixture-of-Experts — only part of the model runs per token",
		tone: "violet",
	},
	{
		id: "precision",
		aliases: ["fp16", "f16", "bf16", "fp32", "f32"],
		label: "Full precision",
		tooltip: "Uncompressed weights — highest quality, largest size",
		tone: "neutral",
	},
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
	{
		id: "preview",
		aliases: ["preview", "experimental", "beta", "alpha", "rc"],
		label: "Preview",
		tooltip: "Early / experimental release",
		tone: "amber",
	},
	{
		id: "longcontext",
		aliases: ["128k", "256k", "512k", "1m", "long", "longcontext"],
		label: "Long context",
		tooltip: "Handles unusually long inputs",
		tone: "blue",
	},
];

/**
 * Friendly-mode overrides per token: a simpler label for non-technical users, or
 * `hidden` to drop purely-technical badges entirely.
 */
const TOKEN_FRIENDLY: Record<string, { label?: string; hidden?: boolean }> = {
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

// ── Input/output modalities (from the HF pipeline tag) ──────────────────────

/** A data modality a model accepts or produces. */
export type Modality = "text" | "image" | "pdf" | "video" | "audio";

/** What a model takes in and puts out, derived from its pipeline tag. */
export interface ModalityFlow {
	inputs: Modality[];
	outputs: Modality[];
}

// ---------------------------------------------------------------------------
// Model-catalog display helpers (moved from apps/desktop with the Models
// section). Pure, framework-free — used by the shared Models catalog section.
// ---------------------------------------------------------------------------

/** Number of segments in the friendly quality meter. */
export const QUANT_QUALITY_MAX = 5;

/** Plain-language compression level for a GGUF quant. */
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

// Every alias across the token vocabulary, for stripping consumed segments from
// a friendly model name.
const ALL_ALIASES = new Set<string>(CATALOG_TOKENS.flatMap((t) => t.aliases));

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
// matrix) families are tried before the plain K-quants.
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

/**
 * Plain-language compression level for a GGUF quant label (`Q4_K_M`, `Q8_0`,
 * `F16`, …). The raw label is always echoed in the tooltip so power users keep
 * the exact value. Unknown labels pass through unchanged.
 */
export function friendlyQuant(quant: string | null): QuantInfo {
	if (!quant) {
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
	return { label: quant, tooltip: raw, quality: null };
}

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
 * LOWER is more canonical. Returns a large number for anything unrecognized (or a
 * missing quant) so it sorts last.
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

// ── Input/output modalities (from the HF pipeline tag) ──────────────────────

/** Canonical display order for modality icon rows. */
const MODALITY_ORDER: Modality[] = ["text", "image", "pdf", "video", "audio"];

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
 * Returns `null` when the tag is missing or unrecognized, so callers omit the row.
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
