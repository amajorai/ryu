// Unit tests for the MarkdownJoiner state machine that backs the streaming
// markdown transform. It buffers partial markdown constructs (bold, links, lists,
// MDX tags, code fences) so a split-across-chunks token is not emitted half-formed,
// then releases the joined text. Fully synchronous — no stream/timer involved.

import { describe, expect, test } from "bun:test";
import { MarkdownJoiner } from "./markdown-joiner-transform.ts";

describe("MarkdownJoiner.processText", () => {
	test("passes through plain text with no markdown triggers", () => {
		const j = new MarkdownJoiner();
		expect(j.processText("hello world")).toBe("hello world");
	});

	test("emits a complete bold token from a single chunk", () => {
		const j = new MarkdownJoiner();
		expect(j.processText("**bold**")).toBe("**bold**");
	});

	test("buffers a bold token split across chunks until it completes", () => {
		const j = new MarkdownJoiner();
		expect(j.processText("**bo")).toBe("");
		expect(j.processText("ld**")).toBe("**bold**");
	});

	test("emits a complete inline link", () => {
		const j = new MarkdownJoiner();
		expect(j.processText("[text](url)")).toBe("[text](url)");
	});

	test("emits a complete MDX tag", () => {
		const j = new MarkdownJoiner();
		expect(j.processText("<Component>")).toBe("<Component>");
	});

	test("a newline while buffering flushes the partial buffer (false positive)", () => {
		const j = new MarkdownJoiner();
		// '*' starts buffering; the newline proves it was not a bold token.
		expect(j.processText("*not-bold\n")).toBe("*not-bold\n");
	});

	test("an over-long non-terminating buffer is released rather than swallowed", () => {
		const j = new MarkdownJoiner();
		const input = `*${"x".repeat(40)}`;
		// Whatever the internal chunking, no character is lost.
		expect(j.processText(input)).toBe(input);
	});
});

describe("MarkdownJoiner.flush", () => {
	test("returns and clears whatever remains buffered", () => {
		const j = new MarkdownJoiner();
		expect(j.processText("**partial")).toBe("");
		expect(j.flush()).toBe("**partial");
		// Buffer is now empty; a second flush yields nothing.
		expect(j.flush()).toBe("");
	});
});
