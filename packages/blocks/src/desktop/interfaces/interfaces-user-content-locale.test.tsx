// User-authored text stays as written under a non-English UI. A thread titled
// "Release notes" whose last message is "Draft is ready." partly matches
// catalog templates ("{title} is ready.", "Release {latestRelease}"), so the
// page localizer would rewrite it into "Draftの準備ができました。". Every place
// an interface shows a preview, excerpt or last message marks it
// data-ryu-i18n="off"; status and view labels come from the catalog instead.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	INTERFACE_PROTOCOL_VERSION,
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import type { ComponentType } from "react";
import type { Root } from "react-dom/client";
import JA from "../../../../i18n/locales/ja.json" with { type: "json" };
import type { InterfaceRendererProps } from "./interface-renderer.ts";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { CommunityInterface } = await import("./community-interface.tsx");
const { DashboardInterface } = await import("./dashboard-interface.tsx");
const { DeskInterface } = await import("./desk-interface.tsx");
const { KnowledgeInterface } = await import("./knowledge-interface.tsx");
const { NotebookInterface } = await import("./notebook-interface.tsx");
const { PathInterface } = await import("./path-interface.tsx");
const { FlowInterface } = await import("./flow-interface.tsx");
const { GalleryInterface } = await import("./gallery-interface.tsx");
const { GlanceInterface } = await import("./glance-interface.tsx");
const { InboxInterface } = await import("./inbox-interface.tsx");
const { JournalInterface } = await import("./journal-interface.tsx");
const { MissionControlInterface } = await import(
	"./mission-control-interface.tsx"
);
const { NewspaperInterface } = await import("./newspaper-interface.tsx");
const { NoticeboardInterface } = await import("./noticeboard-interface.tsx");
const { PanelsInterface } = await import("./panels-interface.tsx");
const { QaInterface } = await import("./qa-interface.tsx");
const { RecordsInterface } = await import("./records-interface.tsx");
const { SheetInterface } = await import("./sheet-interface.tsx");
const { StreamInterface } = await import("./stream-interface.tsx");

const catalog: Readonly<Record<string, string>> = JA;

const MESSAGE = "Draft is ready.";
const TITLE = "Release notes";

function thread(overrides: Partial<InterfaceThread>): InterfaceThread {
	return {
		agentIds: ["agent-ada"],
		id: "thread",
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: "Untitled",
		updatedAt: new Date(Date.now() - 26 * 60 * 60_000).toISOString(),
		...overrides,
	};
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "Writes the release notes",
			id: "agent-ada",
			name: "Ada",
			status: "idle",
		},
	],
	groups: [],
	threads: [
		thread({
			id: "thread-notes",
			lastMessage: MESSAGE,
			pinned: true,
			title: TITLE,
		}),
		thread({
			id: "thread-crash",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
		}),
	],
	version: INTERFACE_PROTOCOL_VERSION,
};

const port: InterfacePort = {
	closeThread: () => undefined,
	openThread: () => undefined,
	startThread: () => undefined,
};

// biome-ignore lint/suspicious/noExplicitAny: each interface types its own params.
type AnyInterface = ComponentType<InterfaceRendererProps<any>>;

const INTERFACES: readonly [string, AnyInterface][] = [
	["community", CommunityInterface],
	["dashboard", DashboardInterface],
	["desk", DeskInterface],
	["gallery", GalleryInterface],
	["glance", GlanceInterface],
	["inbox", InboxInterface],
	["journal", JournalInterface],
	["mission-control", MissionControlInterface],
	["newspaper", NewspaperInterface],
	["noticeboard", NoticeboardInterface],
	["panels", PanelsInterface],
	["qa", QaInterface],
	["sheet", SheetInterface],
	["stream", StreamInterface],
];

let mounted: { container: HTMLElement; root: Root } | undefined;

async function render(Interface: AnyInterface): Promise<HTMLElement> {
	registerLiteralCatalogLoader((locale) =>
		locale.startsWith("ja") ? catalog : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<Interface
					activeThreadId={null}
					loading={false}
					params={{}}
					port={port}
					snapshot={SNAPSHOT}
					threadView={null}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

/**
 * Text nodes the page localizer would still visit that hold `text`: anywhere
 * in the node, or (for a title, which copy may quote) as the whole node.
 */
function unprotected(
	root: HTMLElement,
	text: string,
	match: "contains" | "whole"
): string[] {
	const found: string[] = [];
	const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const value = node.nodeValue ?? "";
		const hit =
			match === "whole" ? value.trim() === text : value.includes(text);
		if (hit && !node.parentElement?.closest('[data-ryu-i18n="off"]')) {
			found.push(value);
		}
	}
	return found;
}

afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

describe("interface previews under a Japanese UI", () => {
	for (const [name, Interface] of INTERFACES) {
		test(`${name} shows the last message as written, outside the localizer`, async () => {
			const root = await render(Interface);
			expect(root.textContent).toContain(MESSAGE);
			expect(unprotected(root, MESSAGE, "contains")).toEqual([]);
			expect(root.textContent).not.toContain("Draftの");
			expect(unprotected(root, TITLE, "whole")).toEqual([]);
			expect(root.textContent).not.toContain(catalog[TITLE] ?? TITLE);
		});
	}

	// These show the title but not the last message.
	for (const [name, Interface] of [
		["flow", FlowInterface],
		["knowledge", KnowledgeInterface],
		["notebook", NotebookInterface],
		["path", PathInterface],
	] as const) {
		test(`${name} shows the thread title as written`, async () => {
			const root = await render(Interface);
			expect(root.textContent).toContain(TITLE);
			expect(unprotected(root, TITLE, "whole")).toEqual([]);
			expect(root.textContent).not.toContain(catalog[TITLE] ?? TITLE);
		});
	}

	test("inbox rows name their status in Japanese", async () => {
		const root = await render(InboxInterface);
		const row = root.querySelector('[data-inbox-row="thread-notes"]');
		expect(catalog["Your turn"]).toBeTruthy();
		expect(row?.getAttribute("aria-label")).toContain(
			catalog["Your turn"] ?? ""
		);
		expect(row?.getAttribute("aria-label")).not.toContain("Your turn");
	});

	test("desk views carry their catalog labels, not the protocol's English", async () => {
		const root = await render(DeskInterface);
		const text = root.textContent ?? "";
		expect(text).toContain(catalog["Needs you"] ?? "");
		expect(text).not.toContain("Needs you");
		expect(text).not.toContain("All conversations");
	});

	test("records sort hints use the column's catalog label as written", async () => {
		const root = await render(RecordsInterface);
		const titles = [...root.querySelectorAll("th button[title]")].map(
			(button) => button.getAttribute("title") ?? ""
		);
		expect(titles.length).toBeGreaterThan(0);
		expect(titles.join(" ")).not.toMatch(/[a-z]{3,}/);
		expect(titles).toContain(
			(catalog["Sort by {label}"] ?? "").replace(
				"{label}",
				catalog["Needs you"] ?? ""
			)
		);
	});

	test("flow thread nodes name their status in Japanese", async () => {
		const root = await render(FlowInterface);
		const labels = [...root.querySelectorAll("button[aria-label]")].map(
			(button) => button.getAttribute("aria-label") ?? ""
		);
		const notes = labels.find((label) => label.startsWith(TITLE));
		expect(notes).toContain(catalog["Your turn"] ?? "");
		expect(labels.join(" ")).not.toContain("Your turn");
	});
});
