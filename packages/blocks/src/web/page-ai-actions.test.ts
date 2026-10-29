import { describe, expect, test } from "bun:test";
import { parseRyuDeepLink } from "@ryuhq/protocol/deep-link";
import {
	pageAiActions,
	pageQuestionPrompt,
	ryuChatHref,
} from "./page-ai-actions.ts";

const PAGE_URL = "https://ryuhq.com/help/getting-started";
const PROMPT = pageQuestionPrompt(PAGE_URL);

describe("pageAiActions", () => {
	test("lists Open in Ryu first, then the Fumadocs assistants", () => {
		expect(pageAiActions(PAGE_URL).map((action) => action.title)).toEqual([
			"Open in Ryu",
			"Open in Scira AI",
			"Open in ChatGPT",
			"Open in Claude",
			"Open in Cursor",
		]);
	});

	test("asks every assistant the same question about the page", () => {
		expect(PROMPT).toBe(
			"Read https://ryuhq.com/help/getting-started, I want to ask questions about it."
		);
		for (const action of pageAiActions(PAGE_URL)) {
			expect(decodeURIComponent(action.href.replaceAll("+", " "))).toContain(
				PROMPT
			);
		}
	});

	test("builds each assistant's prompt URL", () => {
		const byId = new Map(
			pageAiActions(PAGE_URL).map((action) => [action.id, action])
		);
		const chatgpt = new URL(byId.get("chatgpt")?.href ?? "");
		expect(chatgpt.origin).toBe("https://chatgpt.com");
		expect(chatgpt.searchParams.get("prompt")).toBe(PROMPT);
		expect(chatgpt.searchParams.get("hints")).toBe("search");
		const claude = new URL(byId.get("claude")?.href ?? "");
		expect(`${claude.origin}${claude.pathname}`).toBe("https://claude.ai/new");
		expect(claude.searchParams.get("q")).toBe(PROMPT);
		const scira = new URL(byId.get("scira")?.href ?? "");
		expect(scira.searchParams.get("q")).toBe(PROMPT);
		const cursor = new URL(byId.get("cursor")?.href ?? "");
		expect(cursor.pathname).toBe("/link/prompt");
		expect(cursor.searchParams.get("text")).toBe(PROMPT);
	});

	test("opens web assistants in a new tab but not the app deep link", () => {
		for (const action of pageAiActions(PAGE_URL)) {
			expect(action.newTab).toBe(action.id !== "ryu");
		}
	});
});

describe("ryuChatHref", () => {
	test("is a new-chat deep link the app parses back to the same prompt", () => {
		const href = ryuChatHref(PROMPT);
		expect(href.startsWith("ryu://chat/new?prompt=")).toBe(true);
		expect(parseRyuDeepLink(href)).toEqual({
			kind: "chat",
			conversationId: null,
			prompt: PROMPT,
			agent: null,
			project: null,
		});
	});
});
