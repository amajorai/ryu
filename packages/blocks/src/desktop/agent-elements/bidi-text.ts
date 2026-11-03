// Bidirectional text in the chat transcript and composer.
//
// A message's direction follows its own text, not the interface language: an
// English reply inside the Arabic UI reads left to right, and an Arabic reply
// inside the English UI reads right to left. `dir="auto"` asks the browser to
// pick the direction from the element's first strong character. Code blocks
// stay forced left to right by base.css.

import { type ComponentType, createElement } from "react";

/** Spread onto any element whose text direction should follow its content. */
export const BIDI_AUTO = { dir: "auto" } as const;

const STRONG_DIRECTION_TEXT = /\p{L}/u;

/**
 * `BIDI_AUTO` for a text field holding `text`, or nothing while it has no
 * letter yet. A `dir="auto"` box with no strong character resolves to left to
 * right, which would put an empty composer's caret and placeholder on the
 * wrong side in a right-to-left interface; until the first letter is typed it
 * inherits the interface direction instead.
 */
export function bidiAutoFor(text: string): { readonly dir?: "auto" } {
	return STRONG_DIRECTION_TEXT.test(text) ? BIDI_AUTO : {};
}

/** Markdown block elements that hold prose and resolve their own direction. */
export const BIDI_AUTO_MARKDOWN_TAGS = [
	"p",
	"li",
	"h1",
	"h2",
	"h3",
	"h4",
	"blockquote",
	"th",
	"td",
] as const;

/**
 * Wrap the listed markdown renderers so each renders with `dir="auto"`. An
 * explicit `dir` passed by the markdown pipeline still wins.
 */
export function withBidiAuto<T extends Record<string, unknown>>(
	components: T,
	tags: readonly string[] = BIDI_AUTO_MARKDOWN_TAGS
): T {
	const wrapped: Record<string, unknown> = { ...components };
	for (const tag of tags) {
		const renderer = components[tag];
		if (typeof renderer !== "function") {
			continue;
		}
		const Renderer = renderer as ComponentType<Record<string, unknown>>;
		const BidiAutoRenderer = (props: Record<string, unknown>) =>
			createElement(Renderer, { ...BIDI_AUTO, ...props });
		BidiAutoRenderer.displayName = `BidiAuto(${tag})`;
		wrapped[tag] = BidiAutoRenderer;
	}
	return wrapped as T;
}
