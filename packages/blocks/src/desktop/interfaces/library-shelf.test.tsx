// The Continue Reading card's "Resume" hover nudge moves toward the inline
// end, so in right-to-left reading it follows the mirrored chevron instead
// of sliding back toward the cover.
import { describe, expect, test } from "bun:test";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { renderToStaticMarkup } from "react-dom/server";
import type { ContinueItem, LibraryBook } from "./library-model.ts";
import { ContinueShelf } from "./library-shelf.tsx";

const NOW = Date.parse("2026-10-12T12:00:00Z");

const THREAD: InterfaceThread = {
	agentIds: [],
	id: "thread-resume",
	lastMessage: null,
	lastMessageRole: "assistant",
	messageCount: 2,
	pinned: false,
	projectId: null,
	running: false,
	teamId: null,
	title: "Draft the launch post",
	updatedAt: "2026-10-12T11:00:00Z",
};

const CHAPTER = {
	finished: true,
	number: 1,
	status: "waiting",
	thread: THREAD,
} as const satisfies ContinueItem["chapter"];

const BOOK: LibraryBook = {
	agentId: null,
	authors: [],
	chapters: [CHAPTER],
	description: "Launch notes",
	finishedCount: 1,
	groupId: null,
	id: "unassigned",
	kind: "unassigned",
	title: "Launch",
	updatedAt: THREAD.updatedAt,
	waiting: [CHAPTER],
	working: false,
};

function resumeClass(): string {
	const markup = renderToStaticMarkup(
		<ContinueShelf
			items={[{ book: BOOK, chapter: CHAPTER, more: 0 }]}
			now={NOW}
			onOpen={() => undefined}
		/>
	);
	return /<span class="([^"]*)">Resume/u.exec(markup)?.[1] ?? "";
}

describe("ContinueShelf resume nudge", () => {
	test("nudges toward the inline end in both reading directions", () => {
		const classes = resumeClass().split(" ");
		expect(classes).toContain("group-hover:translate-x-0.5");
		expect(classes).toContain("group-hover:rtl:-translate-x-0.5");
	});
});
