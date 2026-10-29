import { describe, expect, test } from "bun:test";
import { BaseMentionPlugin } from "@platejs/mention";
import {
	createSlateEditor,
	type Descendant,
	type Path,
	type Point,
	type TMentionElement,
} from "platejs";
import { moveMention } from "./composer-mention-move.ts";

const chip = (id: string): TMentionElement => ({
	children: [{ text: "" }],
	id,
	type: "mention",
	value: id,
});

function move(
	children: Descendant[],
	from: Path,
	dropPoint: Point
): { children: unknown[]; placed: Path | undefined } {
	const editor = createSlateEditor({
		plugins: [BaseMentionPlugin],
		value: [{ children, type: "p" }],
	});
	const [mention] = editor.api.node<TMentionElement>(from) ?? [];
	if (!mention) {
		throw new Error("no mention at source path");
	}
	const placed = moveMention(editor, mention, from, dropPoint);
	return { children: editor.children[0]?.children ?? [], placed };
}

describe("moveMention", () => {
	test("drops the space a line-start chip leaves and pads it mid-word", () => {
		const { children, placed } = move(
			[{ text: "" }, chip("a"), { text: " hello world" }],
			[0, 1],
			{ offset: 4, path: [0, 2] }
		);
		expect(children).toEqual([
			{ text: "hel " },
			chip("a"),
			{ text: " lo world" },
		]);
		expect(placed).toEqual([0, 1]);
	});

	test("collapses the double gap a chip leaves between two spaces", () => {
		const { children } = move(
			[{ text: "one " }, chip("a"), { text: " two" }],
			[0, 1],
			{ offset: 0, path: [0, 0] }
		);
		expect(children).toEqual([{ text: "" }, chip("a"), { text: " one two" }]);
	});

	test("keeps the space separating a chip from the chip before it", () => {
		const { children } = move(
			[{ text: "" }, chip("a"), { text: "" }, chip("b"), { text: " end" }],
			[0, 3],
			{ offset: 4, path: [0, 4] }
		);
		expect(children).toEqual([
			{ text: "" },
			chip("a"),
			{ text: " end " },
			chip("b"),
			{ text: "" },
		]);
	});
});
