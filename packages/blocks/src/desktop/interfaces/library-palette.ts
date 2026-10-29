import type { CoverSpec } from "./library-model.ts";

/**
 * Library's cover palette. Covers are printed objects, so they keep their
 * own inks in every theme: book cloth in the book's hue, a cream paper stock,
 * and a light foil for rules and lettering.
 *
 * This is the one Library file allowed to spell color functions.
 */

export interface CoverInks {
	/** The book cloth. */
	cloth: string;
	/** Lettering and rules stamped on the cloth. */
	foil: string;
	/** Ink printed on the paper band or paper stock. */
	ink: string;
	/** The cream paper band (or the whole board, for paper covers). */
	paper: string;
	/** A fine weave over the cloth, so it reads as bound, not flat. */
	weave: string;
}

export function coverInks(spec: Pick<CoverSpec, "hue" | "layout">): CoverInks {
	const hue = spec.hue.toString();
	const deep = spec.layout === "stack" ? 34 : 28;
	return {
		cloth: `hsl(${hue} 42% ${deep.toString()}%)`,
		foil: `hsl(${hue} 55% 86%)`,
		ink: `hsl(${hue} 45% 22%)`,
		paper: "hsl(42 38% 92%)",
		weave: [
			"repeating-linear-gradient(0deg, hsl(0 0% 100% / 0.035) 0 1px, transparent 1px 3px)",
			"repeating-linear-gradient(90deg, hsl(0 0% 0% / 0.05) 0 1px, transparent 1px 3px)",
			"linear-gradient(160deg, hsl(0 0% 100% / 0.08), hsl(0 0% 0% / 0.12))",
		].join(", "),
	};
}

/** The binding: a shadow ramp into the spine, its crease, and the board edge. */
export const COVER_BINDING = {
	crease: "hsl(0 0% 100% / 0.2)",
	edge: "inset 0 0 0 1px hsl(0 0% 0% / 0.1)",
	spine:
		"linear-gradient(90deg, hsl(0 0% 0% / 0.3), hsl(0 0% 0% / 0.08) 50%, transparent)",
} as const;
