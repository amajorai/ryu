/**
 * What the DOM localizer may rewrite: the text-bearing attributes the
 * extractor (`tools/i18n-extract.mjs`) collects, the elements it must leave
 * alone, and the document-title shape (`Page · Site`).
 */
export const DOM_TRANSLATABLE_ATTRIBUTES = [
	"aria-description",
	"aria-label",
	"aria-placeholder",
	"aria-roledescription",
	"aria-valuetext",
	"alt",
	"placeholder",
	"title",
	"value",
] as const;

export type DomTranslatableAttribute =
	(typeof DOM_TRANSLATABLE_ATTRIBUTES)[number];

/** `<input>` types whose `value` is a visible button label, not user data. */
const BUTTON_INPUT_TYPES = ["button", "reset", "submit"] as const;

/** Every attribute the observer must watch to notice new or changed copy. */
export const DOM_OBSERVED_ATTRIBUTES: readonly string[] = [
	...DOM_TRANSLATABLE_ATTRIBUTES,
	"contenteditable",
	"data-ryu-i18n",
	"type",
];

/** Selector for elements carrying at least one translatable attribute. */
export const DOM_ATTRIBUTE_SELECTOR = [
	...DOM_TRANSLATABLE_ATTRIBUTES.filter(
		(attribute) => attribute !== "value"
	).map((attribute) => `[${attribute}]`),
	...BUTTON_INPUT_TYPES.map((type) => `input[type="${type}"][value]`),
].join(",");

/** Whether `attribute` on `element` holds UI copy. Only button-like inputs
 * expose their `value` as a label; every other `value` is user data. */
export function isTranslatableAttribute(
	element: Element,
	attribute: DomTranslatableAttribute
): boolean {
	if (attribute !== "value") {
		return true;
	}
	const type = (element.getAttribute("type") ?? "").toLowerCase();
	return (
		element.localName === "input" &&
		BUTTON_INPUT_TYPES.some((candidate) => candidate === type)
	);
}

export function hasTranslatableCharacters(value: string): boolean {
	return /[A-Za-zÀ-￿]/u.test(value);
}

export function shouldSkipDomElement(element: Element | null): boolean {
	return Boolean(
		element?.closest(
			'script,style,pre,code,[contenteditable="true"],[data-ryu-i18n="off"]'
		)
	);
}

/** Whether `element` is the document's `<title>` (not an SVG `<title>`). */
export function isDocumentTitle(element: Element): boolean {
	return (
		element.localName === "title" && element.parentElement?.localName === "head"
	);
}

const TITLE_SEPARATORS = [" · ", " | ", " - "] as const;

/**
 * Split a document title such as `Pricing · Ryu` (Next pads the separator
 * with NBSP) into the translatable page title and the untouched site suffix.
 * Returns null when the title has no separator.
 */
export function splitDocumentTitle(
	value: string
): { head: string; tail: string } | null {
	// Each whitespace character (NBSP included) becomes one space, so indices
	// map back to `value`.
	const normalized = value.replace(/\s/gu, " ");
	let index = -1;
	for (const separator of TITLE_SEPARATORS) {
		index = Math.max(index, normalized.lastIndexOf(separator));
	}
	if (index <= 0 || normalized.slice(0, index).trim().length === 0) {
		return null;
	}
	return { head: value.slice(0, index), tail: value.slice(index) };
}
