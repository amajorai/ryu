import { POLISH_LANGUAGE_PACK } from "./locale-pl.ts";
import { OFFICIAL_LANGUAGE_PACKS } from "./locales.ts";
import type { LanguagePack } from "./pack.ts";

/**
 * Every official pack, in catalog order. `locales.ts` holds the packs written
 * before the staged file size limits; a newer locale brings its own
 * `locale-<tag>.ts` files and adds one entry here.
 */
export const ALL_OFFICIAL_LANGUAGE_PACKS: readonly LanguagePack[] = [
	...OFFICIAL_LANGUAGE_PACKS,
	POLISH_LANGUAGE_PACK,
];
