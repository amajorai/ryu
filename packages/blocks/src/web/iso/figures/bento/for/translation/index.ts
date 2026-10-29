import type { BentoDrawings } from "../../card.ts";
import { drawing as backTranslationForQa } from "./back-translation-for-qa.tsx";
import { drawing as bilingualGlossaryExtraction } from "./bilingual-glossary-extraction.tsx";
import { drawing as firstPassDocumentTranslation } from "./first-pass-document-translation.tsx";
import { drawing as localizedFormattingAndUnits } from "./localized-formatting-and-units.tsx";
import { drawing as oneSourceManyLanguages } from "./one-source-many-languages.tsx";
import { drawing as terminologyConsistencyCheck } from "./terminology-consistency-check.tsx";

/** Card drawings for this group, keyed by the exact bento item title. */
export const drawings: BentoDrawings = {
	"First-pass document translation": firstPassDocumentTranslation,
	"Terminology consistency check": terminologyConsistencyCheck,
	"Back-translation for QA": backTranslationForQa,
	"Bilingual glossary extraction": bilingualGlossaryExtraction,
	"Localized formatting and units": localizedFormattingAndUnits,
	"One source, many languages": oneSourceManyLanguages,
};
