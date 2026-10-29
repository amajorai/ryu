import artwork from "./app-icon-art.json" with { type: "json" };

const bundledArtwork = new Map(Object.entries(artwork));

/** Bundled first-party integration artwork; custom URLs keep normal caching. */
export function bundledIconArt(url: string | null | undefined): string | null {
	return url ? (bundledArtwork.get(url) ?? null) : null;
}
