import type { useMediaState } from "@platejs/media/react";

/** The exact optional id slot of the installed media-state output. The supplied
 * parseVideoUrl/parseTwitterUrl providers produce ids for YouTube/Twitter;
 * refuse a missing provider id instead of constructing an undefined embed URL. */
export function requireMediaEmbedId(
	id: NonNullable<ReturnType<typeof useMediaState>["embed"]>["id"]
): string {
	if (id === undefined) {
		throw new Error("Media provider requires an embed id");
	}
	return id;
}
