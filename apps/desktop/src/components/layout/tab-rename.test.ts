import { describe, expect, it, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Tab } from "@/src/contexts/TabsContext.tsx";
import {
	commitTabRename,
	isRenamableTab,
	spaceDocumentRef,
} from "./tab-rename.tsx";

// `isRenamableTab` gates whether a double-click on a tab chip opens the inline
// rename editor. Rename a tab whose title is route-derived and the label would
// be overwritten by the page on the next reload — so those must be excluded.
// `commitTabRename` is the commit seam; the chat half must persist through the
// same `renameConversation` the sidebar uses, and a page tab must NOT be
// persisted here (its editor page does that through `useTabTitleSync`).

function tab(overrides: Partial<Tab>): Tab {
	return { id: "t1", path: "/home", title: "Tab", ...overrides };
}

describe("isRenamableTab", () => {
	it("renames a chat tab with a conversation", () => {
		expect(isRenamableTab(tab({ path: "/chat", conversationId: "c1" }))).toBe(
			true
		);
	});

	it("renames a space page (doc, database, app-owned) tab", () => {
		expect(isRenamableTab(tab({ path: "/spaces/s1/doc/d1" }))).toBe(true);
		expect(isRenamableTab(tab({ path: "/spaces/s1/db/d1" }))).toBe(true);
		expect(isRenamableTab(tab({ path: "/spaces/s1/app/@ryu/canvas/d1" }))).toBe(
			true
		);
	});

	it("refuses a launchpad chat with no conversation yet", () => {
		expect(isRenamableTab(tab({ path: "/chat" }))).toBe(false);
	});

	it("refuses route-derived shell tabs", () => {
		expect(isRenamableTab(tab({ path: "/settings" }))).toBe(false);
		expect(isRenamableTab(tab({ path: "/library/agent" }))).toBe(false);
		expect(isRenamableTab(tab({ path: "/store" }))).toBe(false);
		expect(isRenamableTab(tab({ path: "/home" }))).toBe(false);
	});

	it("refuses a database row detail (it would rename the database)", () => {
		expect(isRenamableTab(tab({ path: "/spaces/s1/db/d1/row/r1" }))).toBe(
			false
		);
	});
});

describe("spaceDocumentRef", () => {
	it("resolves doc, db and app-owned document addresses", () => {
		expect(spaceDocumentRef("/spaces/s1/doc/d1")).toEqual({
			spaceId: "s1",
			documentId: "d1",
		});
		expect(spaceDocumentRef("/spaces/s1/db/d1")).toEqual({
			spaceId: "s1",
			documentId: "d1",
		});
		expect(spaceDocumentRef("/spaces/s1/app/@ryu/canvas/d1")).toEqual({
			spaceId: "s1",
			documentId: "d1",
		});
	});

	it("returns null for non-space routes and row details", () => {
		expect(spaceDocumentRef("/settings")).toBeNull();
		expect(spaceDocumentRef("/spaces/s1/db/d1/row/r1")).toBeNull();
	});

	it("ignores a query string", () => {
		expect(spaceDocumentRef("/spaces/s1/doc/d1?view=full")?.documentId).toBe(
			"d1"
		);
	});
});

describe("commitTabRename", () => {
	it("updates the tab label and persists through renameConversation for a chat", () => {
		const seen: string[] = [];
		commitTabRename(
			tab({ path: "/chat", conversationId: "c1" }),
			"  Renamed  ",
			(id, title) => seen.push(`label:${id}:${title}`),
			(id, title) => seen.push(`rename:${id}:${title}`)
		);
		expect(seen).toEqual(["label:t1:Renamed", "rename:c1:Renamed"]);
	});

	it("updates the tab label but persists nothing for a space page (the editor owns it)", () => {
		const seen: string[] = [];
		commitTabRename(
			tab({ path: "/spaces/s1/doc/d1" }),
			"New page",
			(id, title) => seen.push(`label:${id}:${title}`),
			() => {
				throw new Error("renameConversation must not be called for a page tab");
			}
		);
		expect(seen).toEqual(["label:t1:New page"]);
	});

	it("no-ops on an unchanged or blank title", () => {
		let calls = 0;
		commitTabRename(
			tab({ path: "/chat", conversationId: "c1" }),
			"Tab",
			() => {
				calls += 1;
			},
			() => {
				calls += 1;
			}
		);
		commitTabRename(
			tab({ path: "/chat", conversationId: "c1" }),
			"   ",
			() => {
				calls += 1;
			},
			() => {
				calls += 1;
			}
		);
		expect(calls).toBe(0);
	});
});

const REGULAR_TAB_SOURCE = readFileSync(
	join(import.meta.dir, "..", "shell", "title-bar", "regular-tab.tsx"),
	"utf8"
);
const EDITING_BRANCH = REGULAR_TAB_SOURCE.slice(
	REGULAR_TAB_SOURCE.indexOf("{isEditing ? ("),
	REGULAR_TAB_SOURCE.indexOf(
		") : (",
		REGULAR_TAB_SOURCE.indexOf("{isEditing ? (")
	)
);

describe("RegularTab inline rename structure", () => {
	test("keeps the rename input outside the native activation button", () => {
		expect(REGULAR_TAB_SOURCE).toContain(
			"editor is a sibling of the activation button"
		);
		expect(REGULAR_TAB_SOURCE).toContain("{isEditing ? (");
		expect(REGULAR_TAB_SOURCE).toContain("<TabRenameInput");
		expect(EDITING_BRANCH).not.toContain("<button");
	});
});
