// packages/marketplace/src/catalog/friendly-quant.ts
//
// GGUF quant compression tiers and variant ranking. Split out of friendly.ts, which re-exports
// everything here so `@ryu/marketplace/catalog/friendly` stays the import path.

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
