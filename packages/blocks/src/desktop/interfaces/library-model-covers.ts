import {
	ditherAvatarHue,
	ditherAvatarSeed,
} from "@ryu/ui/components/dither-kit/avatar.tsx";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import type { LibraryBookKind } from "./library-model.ts";

// ---------------------------------------------------------------------------
// Covers
// ---------------------------------------------------------------------------

/**
 * The series a cover is printed in, one per kind of book, so a shelf reads
 * like a publisher's list: agents in the banded series, projects framed,
 * teams in a bold stacked series, and loose conversations on plain paper.
 */
export const COVER_LAYOUTS = ["band", "framed", "stack", "paper"] as const;
export type CoverLayout = (typeof COVER_LAYOUTS)[number];

const LAYOUT_FOR: Record<LibraryBookKind, CoverLayout> = {
	agent: "band",
	project: "framed",
	team: "stack",
	unassigned: "paper",
};

export interface CoverSpec {
	/** Cloth hue in degrees: the lead agent's avatar hue, else one of the book's own. */
	hue: number;
	layout: CoverLayout;
	/** The letter on the colophon: the book's initial. */
	monogram: string;
	seed: number;
}

/** FNV-1a, so a book keeps its cover across sessions and renames of others. */
export function hashString(value: string): number {
	let hash = 2_166_136_261;
	for (const char of value) {
		hash ^= char.codePointAt(0) ?? 0;
		hash = Math.imul(hash, 16_777_619);
	}
	return hash >>> 0;
}

/**
 * A book's cover. Agent books are bound in that agent's colour (the hue its
 * dither avatar is drawn in); collections take a hue from their own id.
 */
export function coverSpec(
	bookId: string,
	kind: LibraryBookKind = "agent",
	title = "",
	lead: Pick<InterfaceAgent, "id" | "name"> | null = null
): CoverSpec {
	const seed = hashString(bookId);
	const letter = /[\p{L}\p{N}]/u.exec(title)?.[0] ?? "R";
	return {
		hue:
			kind === "agent" && lead
				? ditherAvatarHue(ditherAvatarSeed(lead))
				: seed % 360,
		layout: LAYOUT_FOR[kind],
		monogram: letter.toUpperCase(),
		seed,
	};
}
