// Display labels for the optional llmfit speed estimate on a model's detail page.
//
// Core passes llmfit's `fit_level` ("Perfect", "Good", "Marginal", "Too Tight")
// and run `path` ("gpu", "cpu_offload", "cpu_only") through verbatim
// (`crates/core/model-catalog/src/llmfit.rs`). Each known word becomes a whole
// translated message here; the memory line is one message per path rather than
// a translated template with an English suffix spliced in. The engine's words
// are free-form, so an unknown word is shown as it came.

import { formatNumberValue } from "@ryu/i18n/format-intl";
import type { LiteralMessage } from "@ryu/i18n/react";

/** Lower-case, with `_`, `-` and runs of spaces folded to one space. */
function normalizeWord(word: string): string {
	return word
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/gu, " ");
}

/** The badge text for llmfit's fit level; an unknown level shows raw. */
export function llmfitFitLabel(tl: LiteralMessage, level: string): string {
	switch (normalizeWord(level)) {
		case "perfect":
			return tl("Perfect fit");
		case "good":
			return tl("Good fit");
		case "marginal":
			return tl("Marginal fit");
		case "too tight":
		case "tootight":
			return tl("Too tight to fit");
		default:
			return level.trim();
	}
}

/**
 * "needs 4,5 GB graphics memory · GPU": the minimum graphics memory in the
 * formatting locale, plus the run path, as one whole message per path.
 */
export function llmfitMemoryLine(
	tl: LiteralMessage,
	locale: string,
	minVramGb: number,
	path: string | null | undefined
): string {
	const memory = formatNumberValue(locale, minVramGb, {
		maximumFractionDigits: 1,
		minimumFractionDigits: 1,
	});
	const raw = path?.trim() ?? "";
	if (raw === "") {
		return tl("needs {memory} GB graphics memory", { memory });
	}
	switch (normalizeWord(raw)) {
		case "gpu":
			return tl("needs {memory} GB graphics memory · GPU", { memory });
		case "cpu offload":
			return tl("needs {memory} GB graphics memory · CPU offload", {
				memory,
			});
		case "cpu only":
			return tl("needs {memory} GB graphics memory · CPU only", { memory });
		default:
			return tl("needs {memory} GB graphics memory · {path}", {
				memory,
				path: raw,
			});
	}
}

/** The estimated token rate, rounded and grouped for the formatting locale. */
export function llmfitRateLabel(
	tl: LiteralMessage,
	locale: string,
	tokensPerSecond: number
): string {
	return tl("≈{rate} tokens/sec", {
		rate: formatNumberValue(locale, Math.round(tokensPerSecond), {
			maximumFractionDigits: 0,
		}),
	});
}
