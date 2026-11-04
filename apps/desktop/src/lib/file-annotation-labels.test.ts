import { expect, test } from "bun:test";
import type { LiteralMessage } from "@ryu/i18n/react";
import {
	fileAnnotationLineLabel,
	fileAnnotationNoteTitle,
	fileAnnotationRemoveLabel,
} from "./file-annotation-labels.ts";

// Records the whole message chosen and the values it was filled with.
const tl: LiteralMessage = (source, values = {}) =>
	`${source} ${JSON.stringify(values)}`;

test("one line and a range pick different whole messages", () => {
	expect(fileAnnotationNoteTitle(tl, { endLine: 4, startLine: 4 })).toBe(
		'Note on line {line} {"line":"4"}'
	);
	expect(fileAnnotationNoteTitle(tl, { endLine: 9, startLine: 4 })).toBe(
		'Note on lines {start}–{end} {"end":"9","start":"4"}'
	);
	expect(fileAnnotationLineLabel(tl, { endLine: 4, startLine: 4 })).toBe(
		'Line {line} {"line":"4"}'
	);
	expect(fileAnnotationRemoveLabel(tl, { endLine: 9, startLine: 4 })).toBe(
		'Remove note on lines {start}–{end} {"end":"9","start":"4"}'
	);
});

test("line numbers are not grouped, like the gutter", () => {
	expect(
		fileAnnotationLineLabel(tl, { endLine: 12_345, startLine: 1200 })
	).toBe('Lines {start}–{end} {"end":"12345","start":"1200"}');
});
