import { describe, expect, test } from "bun:test";
import {
	appendAttachmentMentions,
	labelComposerAttachments,
	moveComposerToken,
	remapAttachmentMentions,
} from "./composer-attachment-mentions.ts";

const cat = { filename: "cat.png", id: "a", mimeType: "image/png", url: "" };
const dog = { filename: "dog.png", id: "b", mimeType: "image/png", url: "" };
const fox = { filename: "fox.jpg", id: "c", mimeType: "image/jpeg", url: "" };
const notes = {
	filename: "notes.txt",
	id: "n",
	mimeType: "text/plain",
	url: "",
};

describe("labelComposerAttachments", () => {
	test("numbers images and files independently in staged order", () => {
		const labels = labelComposerAttachments(
			[cat, notes, dog],
			[{ filename: "spec.pdf", id: "p" }]
		);
		expect(labels.map((item) => item.label)).toEqual([
			"image-1",
			"file-1",
			"image-2",
			"file-2",
		]);
	});
});

describe("appendAttachmentMentions", () => {
	test("appends new tokens to the end of the draft", () => {
		const labels = labelComposerAttachments([cat, dog], []);
		expect(appendAttachmentMentions("", labels)).toBe("@image-1 @image-2 ");
		expect(appendAttachmentMentions("make", labels.slice(1))).toBe(
			"make @image-2 "
		);
	});

	test("does not duplicate a token the draft already has", () => {
		const labels = labelComposerAttachments([cat], []);
		expect(appendAttachmentMentions("@image-1's face", labels)).toBe(
			"@image-1's face"
		);
	});
});

describe("remapAttachmentMentions", () => {
	test("drops the removed attachment and renumbers the rest", () => {
		const before = labelComposerAttachments([cat, dog, fox], []);
		const after = labelComposerAttachments([cat, fox], []);
		expect(
			remapAttachmentMentions(
				"@image-3 into @image-2 and @image-1",
				before,
				after
			)
		).toBe("@image-2 into and @image-1");
	});

	test("renumbering does not collide with an existing lower token", () => {
		const before = labelComposerAttachments([cat, dog, fox], []);
		const after = labelComposerAttachments([dog, fox], []);
		expect(
			remapAttachmentMentions("@image-2 then @image-3", before, after)
		).toBe("@image-1 then @image-2");
	});

	test("leaves unrelated mentions alone", () => {
		const before = labelComposerAttachments([cat], []);
		expect(remapAttachmentMentions("@agent @image-10", before, [])).toBe(
			"@agent @image-10"
		);
	});
});

describe("moveComposerToken", () => {
	const text = "@image-1 turn into @image-2 face";

	test("moves a token later in the text", () => {
		expect(moveComposerToken(text, 0, 8, text.length)).toEqual({
			caret: text.length,
			text: "turn into @image-2 face @image-1",
		});
	});

	test("moves a token earlier and keeps single spaces", () => {
		const start = text.indexOf("@image-2");
		expect(moveComposerToken(text, start, start + 8, 0)?.text).toBe(
			"@image-2 @image-1 turn into face"
		);
	});

	test("keeps a possessive suffix attached", () => {
		const value = "turn @image-1 into 's face";
		const drop = value.indexOf("'s");
		expect(moveComposerToken(value, 5, 13, drop)?.text).toBe(
			"turn into @image-1's face"
		);
	});

	test("returns null when dropped on itself or its own gap", () => {
		expect(moveComposerToken(text, 0, 8, 4)).toBeNull();
		expect(moveComposerToken(text, 0, 8, 9)).toBeNull();
	});
});
