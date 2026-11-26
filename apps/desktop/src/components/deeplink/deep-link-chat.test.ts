import { describe, expect, test } from "bun:test";
import { parseRyuDeepLink } from "@ryuhq/protocol/deep-link";
import {
	type ChatIntent,
	type KnownFolders,
	keepFirstPending,
	planNewChatLink,
} from "./deep-link-chat.ts";

// Security sweep 19 Nov 2026, finding DT-1: a link's project folder is used at
// once only when the user already has it; any other folder needs a confirm.

const chatLink = (raw: string): ChatIntent => {
	const intent = parseRyuDeepLink(raw);
	if (intent?.kind !== "chat") {
		throw new Error(`not a chat intent: ${raw}`);
	}
	return intent;
};

const NOTHING_KNOWN: KnownFolders = {
	projects: [],
	recentFolders: [],
	removedProjects: [],
};

const KNOWN: KnownFolders = {
	projects: [{ folders: ["C:\\Users\\me\\app"] }],
	recentFolders: ["/home/me/notes/"],
	removedProjects: [],
};

describe("planNewChatLink", () => {
	test("a folder the user does not have waits for a confirm", () => {
		const plan = planNewChatLink(
			chatLink(
				"ryu://chat/new?prompt=hi&agent=ryu&project=C%3A%5CUsers%5Cme%5CDownloads%5Cx"
			),
			KNOWN
		);
		expect(plan.confirmProject).toBe("C:\\Users\\me\\Downloads\\x");
		expect(plan.options).toEqual({
			forceNew: true,
			title: "New chat",
			initialPrompt: "hi",
			initialAgent: "ryu",
			initialProject: undefined,
		});
	});

	test("with no projects at all, any folder waits for a confirm", () => {
		const plan = planNewChatLink(
			chatLink("ryu://chat/new?project=%2Fhome%2Fme%2Fapp"),
			NOTHING_KNOWN
		);
		expect(plan.confirmProject).toBe("/home/me/app");
		expect(plan.options.initialProject).toBeUndefined();
	});

	test("a known project or recent folder opens at once, in any spelling", () => {
		for (const [raw, folder] of [
			["ryu://chat/new?project=C%3A%2FUsers%2Fme%2Fapp%2F", "C:/Users/me/app/"],
			["ryu://chat/new?project=%2Fhome%2Fme%2Fnotes", "/home/me/notes"],
		] as const) {
			const plan = planNewChatLink(chatLink(raw), KNOWN);
			expect(plan.confirmProject).toBeNull();
			expect(plan.options.initialProject).toBe(folder);
		}
	});

	test("a project the user removed counts as unknown", () => {
		const plan = planNewChatLink(
			chatLink("ryu://chat/new?project=C%3A%5CUsers%5Cme%5Capp"),
			{ ...KNOWN, removedProjects: ["C:\\Users\\me\\app"] }
		);
		expect(plan.confirmProject).toBe("C:\\Users\\me\\app");
		expect(plan.options.initialProject).toBeUndefined();
	});

	test("a network path never reaches the tab or the dialog", () => {
		const plan = planNewChatLink(
			chatLink("ryu://chat/new?prompt=hi&project=%5C%5Chost%5Cshare"),
			NOTHING_KNOWN
		);
		expect(plan.confirmProject).toBeNull();
		expect(plan.options.initialProject).toBeUndefined();
		expect(plan.options.initialPrompt).toBe("hi");
	});

	test("a link with no folder opens at once", () => {
		const plan = planNewChatLink(
			chatLink("ryu://chat/new?prompt=hi"),
			NOTHING_KNOWN
		);
		expect(plan.confirmProject).toBeNull();
		expect(plan.options.initialPrompt).toBe("hi");
	});
});

// Security review of PR #1344: a second link that arrives while the folder
// dialog is open must not replace the folder the dialog shows and confirms.
describe("keepFirstPending", () => {
	interface Pending {
		intent: ChatIntent;
		project: string;
	}
	// The controller's state step for one inbound link, as it calls it.
	const arrive = (current: Pending | null, raw: string): Pending | null => {
		const intent = chatLink(raw);
		const plan = planNewChatLink(intent, NOTHING_KNOWN);
		return plan.confirmProject
			? keepFirstPending(current, { intent, project: plan.confirmProject })
			: current;
	};
	const FIRST = "ryu://chat/new?prompt=one&project=C%3A%5CUsers%5Cme%5Cfirst";
	const SECOND = "ryu://chat/new?prompt=two&project=C%3A%5CUsers%5Cme%5Csecond";

	test("a later link does not replace the folder of an open dialog", () => {
		const shown = arrive(null, FIRST);
		const after = arrive(shown, SECOND);
		expect(after).toBe(shown);
		expect(after?.project).toBe("C:\\Users\\me\\first");
		expect(after?.intent.prompt).toBe("one");
	});

	test("once the dialog is closed, the next link is asked about", () => {
		const after = arrive(null, SECOND);
		expect(after?.project).toBe("C:\\Users\\me\\second");
		expect(after?.intent.prompt).toBe("two");
	});
});
