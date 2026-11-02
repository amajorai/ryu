// A label spliced into a translated sentence.
//
// English copy lowercases a Title-case label mid-sentence ("About free
// credit", "No archived notifications"). Lowercasing the English label
// before it reaches `tl()` left the label English in every other language
// ("free creditについて"). `sentenceLabel` translates the label first and
// lowercases only when it is still the English source, so English keeps its
// sentence casing and every other language gets the translator's own form.

/** Any `tl()`-shaped translator: `useLiteralMessages()`, `translate`, … */
export type SentenceLabelTranslator = (source: string) => string;

/**
 * `label` as it reads inside a sentence: the translated label when the
 * catalog has one, else the English label in lowercase.
 *
 * ```ts
 * tl("About {label}", { label: sentenceLabel(tl, label) });
 * ```
 */
export function sentenceLabel(
	translate: SentenceLabelTranslator,
	label: string
): string {
	const translated = translate(label);
	return translated === label ? label.toLowerCase() : translated;
}
