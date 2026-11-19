import type { LiteralMessage } from "@ryu/i18n";
import type { CatalogLayer } from "./types-layers.ts";

/**
 * Human-facing label shared by cards, detail heroes, and the provider picker:
 * one whole sentence per kind ("{title} toolkit", "{title} layer") so the
 * catalog translates the word around the publisher's title.
 */
export function catalogLayerLabel(
	layer: CatalogLayer,
	tl: LiteralMessage
): string {
	const title = layer.title?.trim() || layer.capability;
	return layer.toolkit
		? tl("{title} toolkit", { title })
		: tl("{title} layer", { title });
}

/** Compact badges for a catalog card or detail hero. */
export function catalogLayerBadges(
	layers: CatalogLayer[] | null | undefined,
	tl: LiteralMessage,
	external = false
): string[] {
	const labels = (layers ?? []).map((layer) => catalogLayerLabel(layer, tl));
	if (external) {
		labels.unshift(tl("External"));
	}
	return labels;
}
