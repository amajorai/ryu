import type { NumberedStep } from "../step-list.tsx";

/** A short "who it is for" entry. */
export interface ProductAudience {
	description: string;
	title: string;
}

/**
 * The plain-language sections a product page adds around its capabilities: what
 * the product is, how it works, who it is for, and what it works with. Every
 * field is optional and its section only renders when it is set. All copy comes
 * from the product's own catalog entry (`../data/products.tsx`); nothing here may
 * claim more than that entry does.
 */
export interface ProductExplainer {
	/** "Who it is for" entries; two or three read best. */
	builtFor?: readonly ProductAudience[];
	/** One paragraph. The first sentence is set in the foreground colour. */
	statement?: string;
	/** Three steps, in the order a person takes them. */
	steps?: readonly [NumberedStep, NumberedStep, NumberedStep];
	/** Heading for the steps; planned products say so. Defaults to "How it works". */
	stepsTitle?: string;
	/** Related product slugs, in display order. */
	worksWith?: readonly string[];
}
