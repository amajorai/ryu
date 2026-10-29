// Editor transform for dragging a mention chip to a new spot in the composer.
// Kept free of React so it can run against a headless Slate editor in tests.

import type { Path, Point, SlateEditor, TMentionElement, TText } from "platejs";
import {
	mentionDropPadding,
	shouldTrimGapAfterRemovedMention,
} from "./composer-mention-drop.ts";

/**
 * Moves `mention` from `from` to `dropPoint`, dropping the gap it leaves behind
 * and padding it with spaces at its new spot. Returns the chip's new path, or
 * `undefined` when the drop point no longer resolves to a text node.
 */
export function moveMention(
	editor: SlateEditor,
	mention: TMentionElement,
	from: Path,
	dropPoint: Point
): Path | undefined {
	const target = editor.api.pointRef(dropPoint);
	// Drop the space the chip leaves behind when it was the line's first word
	// or sat between two spaces, so moving it doesn't strand a double gap.
	const position = from.at(-1) ?? 0;
	const parentPath = from.slice(0, -1);
	const previous =
		position > 0
			? editor.api.node<TText>([...parentPath, position - 1])?.[0].text
			: undefined;
	const nextPath = [...parentPath, position + 1];
	const next = editor.api.node<TText>(nextPath)?.[0].text;
	if (shouldTrimGapAfterRemovedMention(previous, next, position)) {
		editor.tf.delete({
			at: {
				anchor: { offset: 0, path: nextPath },
				focus: { offset: 1, path: nextPath },
			},
		});
	}
	editor.tf.removeNodes({ at: from });
	const at = target.unref();
	const entry = at ? editor.api.node<TText>(at.path) : undefined;
	const parent = at ? editor.api.parent(at.path) : undefined;
	if (!(at && entry && parent)) {
		return;
	}
	// Pad with spaces so the chip stays a whitespace-delimited `@label` once
	// the draft round-trips through Markdown (`a@b` would not parse back).
	const text = entry[0].text;
	const index = at.path.at(-1) ?? 0;
	const before = at.offset > 0 ? text[at.offset - 1] : undefined;
	const after = at.offset < text.length ? text[at.offset] : undefined;
	const hasPrevious = before !== undefined || index > 0;
	const hasNext = after !== undefined || index < parent[0].children.length - 1;
	const { lead, trail } = mentionDropPadding({
		after,
		before,
		hasNext,
		hasPrevious,
	});
	editor.tf.insertNodes(
		[
			...(lead ? [{ text: " " }] : []),
			mention,
			...(trail ? [{ text: " " }] : []),
		],
		{ at }
	);
	return editor.api.node({
		at: [],
		match: (node) => "id" in node && node.id === mention.id,
	})?.[1];
}
