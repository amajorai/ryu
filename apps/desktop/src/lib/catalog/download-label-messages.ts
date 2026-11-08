// apps/desktop/src/lib/catalog/download-label-messages.ts
//
// Core builds most Download Center labels from English `format!` templates
// (`DownloadSpec { label: format!("Ryu update ({name})") }`). Rather than give
// every `DownloadSpec` a message id, the client recognizes those label shapes
// here and renders each one through an explicit `tl` sentence, so the
// extractor sees the keys and the coverage gate checks them. Product names,
// URLs, file names and commands inside a placeholder stay as Core wrote them.
//
// The Rust file and exact English template behind each entry are listed in
// `download-label-mirrors.fixture.ts` (kept out of this module so the extractor
// does not catalog Rust source text); `download-label-messages.test.ts` fails
// when a template drifts.

import type { LiteralMessage } from "@ryu/i18n";

/** A recognized Core download label shape. */
export interface DownloadLabelMessage {
	/** Placeholder names, in capture-group order. */
	params: readonly string[];
	/** Placeholders that hold a URL or path (shortened in compact surfaces). */
	pathParams?: readonly string[];
	/** Anchored pattern over the raw label; group n fills `params[n - 1]`. */
	pattern: RegExp;
	/** Renders the localized label with the explicit `tl` key. */
	render: (tl: LiteralMessage, values: Record<string, string>) => string;
}

/** The localized llama.cpp build variant (`LlamaVariant::label` in Core). */
function llamaVariantLabel(tl: LiteralMessage, variant: string): string {
	switch (variant) {
		case "CPU only":
			return tl("CPU only");
		case "Apple GPU (Metal)":
			return tl("Apple GPU (Metal)");
		case "NVIDIA GPU (CUDA)":
			return tl("NVIDIA GPU (CUDA)");
		case "GPU (Vulkan)":
			return tl("GPU (Vulkan)");
		default:
			return variant;
	}
}

/** Ordered: the first matching entry wins. */
export const DOWNLOAD_LABEL_MESSAGES: readonly DownloadLabelMessage[] = [
	{
		pattern: /^Ryu update \((.+)\)$/,
		params: ["name"],
		render: (tl, values) => tl("Ryu update ({name})", values),
	},
	{
		pattern: /^(.+) tool and skill router weights$/,
		params: ["label"],
		render: (tl, values) => tl("{label} tool and skill router weights", values),
	},
	{
		pattern: /^(.+) tool and skill router$/,
		params: ["label"],
		render: (tl, values) => tl("{label} tool and skill router", values),
	},
	{
		pattern: /^app sidecar bundle: (.+)$/,
		params: ["url"],
		pathParams: ["url"],
		render: (tl, values) => tl("App sidecar bundle: {url}", values),
	},
	{
		pattern: /^app sidecar: (.+)$/,
		params: ["command"],
		pathParams: ["command"],
		render: (tl, values) => tl("App sidecar: {command}", values),
	},
	{
		pattern: /^plugin runtime source: (.+)$/,
		params: ["url"],
		pathParams: ["url"],
		render: (tl, values) => tl("Plugin runtime source: {url}", values),
	},
	{
		pattern: /^plugin asset: (.+)$/,
		params: ["source"],
		pathParams: ["source"],
		render: (tl, values) => tl("Plugin asset: {source}", values),
	},
	{
		pattern: /^plugin sidecar binary: (.+)$/,
		params: ["url"],
		pathParams: ["url"],
		render: (tl, values) => tl("Plugin sidecar binary: {url}", values),
	},
	{
		pattern: /^plugin sidecar archive: (.+)$/,
		params: ["url"],
		pathParams: ["url"],
		render: (tl, values) => tl("Plugin sidecar archive: {url}", values),
	},
	{
		pattern: /^(CUDA|audio\.cpp) runtime$/,
		params: ["name"],
		render: (tl, values) => tl("{name} runtime", values),
	},
	{
		pattern: /^(whisper\.cpp|Silero VAD|audio\.cpp PocketTTS) model$/,
		params: ["name"],
		render: (tl, values) => tl("{name} model", values),
	},
	{
		pattern: /^(audio\.cpp Alba) voice$/,
		params: ["name"],
		render: (tl, values) => tl("{name} voice", values),
	},
	{
		pattern: /^(OuteTTS|Kokoro 82M) \(weights\)$/,
		params: ["name"],
		render: (tl, values) => tl("{name} (weights)", values),
	},
	{
		pattern: /^(OuteTTS) \(vocoder\)$/,
		params: ["name"],
		render: (tl, values) => tl("{name} (vocoder)", values),
	},
	{
		pattern: /^(Kokoro 82M) \(voice pack\)$/,
		params: ["name"],
		render: (tl, values) => tl("{name} (voice pack)", values),
	},
	{
		pattern:
			/^llama\.cpp \((CPU only|Apple GPU \(Metal\)|NVIDIA GPU \(CUDA\)|GPU \(Vulkan\))\)$/,
		params: ["variant"],
		render: (tl, values) =>
			tl("llama.cpp ({variant})", {
				variant: llamaVariantLabel(tl, values.variant ?? ""),
			}),
	},
	{
		pattern: /^(Ryu Audio) sidecar$/,
		params: ["name"],
		render: (tl, values) => tl("{name} sidecar", values),
	},
	{
		pattern: /^(Parakeet v3) \(archive\)$/,
		params: ["name"],
		render: (tl, values) => tl("{name} (archive)", values),
	},
	{
		pattern: /^(.+) text encoder \(([^()]+)\)$/,
		params: ["name", "detail"],
		render: (tl, values) => tl("{name} text encoder ({detail})", values),
	},
	{
		pattern: /^(.+) image encoder$/,
		params: ["name"],
		render: (tl, values) => tl("{name} image encoder", values),
	},
	{
		pattern: /^(.+) vision projector \(([^()]+)\)$/,
		params: ["name", "detail"],
		render: (tl, values) => tl("{name} vision projector ({detail})", values),
	},
	{
		pattern: /^(.+) video model \(([^()]+)\)$/,
		params: ["name", "detail"],
		render: (tl, values) => tl("{name} video model ({detail})", values),
	},
];

const PATH_SEPARATOR_RE = /[\\/]/;

/** The last path segment of a URL or path, or the value when it has none. */
export function lastPathSegment(value: string): string {
	const segment = value.split(PATH_SEPARATOR_RE).pop();
	return segment && segment.length > 0 ? segment : value;
}

/**
 * The localized label for a Core download label of a recognized shape, or
 * `null` when no entry matches (the caller keeps the raw label). With
 * `compact`, URL and path placeholders show only their last segment.
 */
export function localizedDownloadLabel(
	label: string,
	tl: LiteralMessage,
	options: { compact?: boolean } = {}
): string | null {
	for (const entry of DOWNLOAD_LABEL_MESSAGES) {
		const match = entry.pattern.exec(label);
		if (!match) {
			continue;
		}
		const values: Record<string, string> = {};
		for (const [index, name] of entry.params.entries()) {
			const raw = match[index + 1] ?? "";
			values[name] =
				options.compact && entry.pathParams?.includes(name)
					? lastPathSegment(raw)
					: raw;
		}
		const rendered = entry.render(tl, values);
		return rendered.length > 0 ? rendered : null;
	}
	return null;
}
