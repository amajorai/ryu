import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { GalleryCover } from "./gallery-cover.tsx";
import { GalleryInterface } from "./gallery-interface.tsx";
import {
	EMPTY_GALLERY_FILTER,
	GALLERY_COVER_KINDS,
	galleryAgentChips,
	galleryByline,
	galleryColumnCount,
	galleryColumns,
	galleryCover,
	galleryItems,
	galleryNoMatchText,
	galleryRelated,
} from "./gallery-model.ts";

const MINUTE = 60_000;
const BASE = Date.parse("2026-10-12T12:00:00Z");
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();

function thread(
	input: Partial<InterfaceThread> & Pick<InterfaceThread, "id">
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: "assistant",
		messageCount: 2,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: input.id,
		updatedAt: ago(60),
		...input,
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
		{
			avatarUrl: null,
			description: "Triages bugs",
			id: "agent-grace",
			name: "Grace",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "Never messaged",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Website",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			projectId: "project-site",
			title: "Release notes",
			updatedAt: ago(30),
		}),
		thread({
			agentIds: ["agent-ada"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			projectId: "project-site",
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
		thread({
			id: "thread-loose",
			lastMessage: "Who owns this?",
			lastMessageRole: "user",
			pinned: true,
			title: "Loose ends",
			updatedAt: ago(600),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	return {
		container,
		async dispose() {
			await act(async () => root.unmount());
			container.remove();
		},
	};
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function buttonByLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

function cardIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll("[data-thread-id]")].map(
		(card) => card.getAttribute("data-thread-id") ?? ""
	);
}

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

function render(
	overrides: Partial<Parameters<typeof GalleryInterface>[0]> = {}
) {
	const { port } = recordingPort();
	return renderToStaticMarkup(
		<GalleryInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...overrides}
		/>
	);
}

describe("gallery model", () => {
	test("covers are chosen from the thread's content and stay stable", () => {
		const items = galleryItems(SNAPSHOT);
		for (const item of items) {
			expect(GALLERY_COVER_KINDS).toContain(item.cover.kind);
			expect(item.cover.ratio).toBeGreaterThan(0.5);
			expect(item.cover.ratio).toBeLessThan(2);
		}
		const byId = (id: string) =>
			items.find((item) => item.thread.id === id)?.cover;
		expect(byId("thread-triage")?.kind).toBe("status");
		expect(byId("thread-flaky")?.kind).toBe("status");
		const thread = SNAPSHOT.threads[0];
		if (thread) {
			expect(galleryCover(thread)).toEqual(galleryCover(thread));
			const quiet = { ...thread, lastMessage: null, runState: null };
			expect(galleryCover(quiet).kind).toBe("stat");
			expect(
				galleryCover(quiet, [], { kind: "project", name: "Website" }, true).kind
			).toBe("poster");
			const short = galleryCover({ ...quiet, lastMessage: "Done." });
			const long = galleryCover({ ...quiet, lastMessage: "word ".repeat(60) });
			expect(short.kind).toBe("quote");
			expect(long.ratio).toBeGreaterThan(short.ratio);
		}
	});

	test("orders pinned first, then most recent, and filters", () => {
		expect(galleryItems(SNAPSHOT).map((item) => item.thread.id)).toEqual([
			"thread-loose",
			"thread-triage",
			"thread-notes",
			"thread-question",
			"thread-flaky",
		]);
		const ids = (filter: Partial<typeof EMPTY_GALLERY_FILTER>) =>
			galleryItems(SNAPSHOT, { ...EMPTY_GALLERY_FILTER, ...filter }).map(
				(item) => item.thread.id
			);
		expect(ids({ status: "working" })).toEqual(["thread-triage"]);
		expect(ids({ status: "attention" })).toEqual(["thread-flaky"]);
		expect(ids({ status: "your-turn" })).toEqual(["thread-notes"]);
		expect(ids({ agentId: "agent-ada" })).toEqual([
			"thread-notes",
			"thread-question",
		]);
		expect(ids({ query: "website" })).toEqual([
			"thread-triage",
			"thread-notes",
		]);
		expect(ids({ query: "  GRACE " })).toEqual([
			"thread-triage",
			"thread-flaky",
		]);
	});

	test("agent chips list only agents that appear on a thread", () => {
		expect(galleryAgentChips(SNAPSHOT).map((agent) => agent.name)).toEqual([
			"Ada",
			"Grace",
		]);
	});

	test("masonry keeps every card once and balances the columns", () => {
		const items = galleryItems(SNAPSHOT);
		const columns = galleryColumns(items, 3, 220);
		expect(columns).toHaveLength(3);
		expect(
			columns
				.flat()
				.map((item) => item.thread.id)
				.sort()
		).toEqual(items.map((item) => item.thread.id).sort());
		expect(columns.every((column) => column.length > 0)).toBe(true);
		expect(galleryColumns(items, 0, 220)).toHaveLength(1);
	});

	test("column count follows the width", () => {
		expect(galleryColumnCount(1392, 16)).toBe(5);
		expect(galleryColumnCount(852, 16)).toBe(3);
		expect(galleryColumnCount(640, 16)).toBe(2);
		expect(galleryColumnCount(358, 12)).toBe(2);
		expect(galleryColumnCount(240, 12)).toBe(1);
		expect(galleryColumnCount(4000, 16)).toBe(7);
		expect(galleryColumnCount(1000, 16)).toBe(4);
	});

	test("more like this prefers a shared agent or project", () => {
		const related = galleryRelated(SNAPSHOT, "thread-notes", 3).map(
			(item) => item.thread.id
		);
		expect(related).toEqual([
			"thread-question",
			"thread-triage",
			"thread-loose",
		]);
		expect(related).not.toContain("thread-notes");
	});

	test("bylines and the no-match sentence read naturally", () => {
		const [ada, grace] = SNAPSHOT.agents;
		expect(galleryByline([])).toBe("No agent");
		expect(galleryByline(ada ? [ada] : [])).toBe("Ada");
		expect(galleryByline(ada && grace ? [ada, grace] : [])).toBe("Ada +1");
		expect(
			galleryNoMatchText({ ...EMPTY_GALLERY_FILTER, query: "zebra" }, "Ada")
		).toContain("“zebra”");
		expect(
			galleryNoMatchText(
				{ ...EMPTY_GALLERY_FILTER, agentId: "agent-ada" },
				"Ada"
			)
		).toBe("Ada has no conversations in this view.");
	});
});

describe("GalleryCover", () => {
	const base = galleryItems(SNAPSHOT)[0]?.cover;

	test("every cover type renders its content cleanly", () => {
		if (!base) {
			throw new Error("fixture has threads");
		}
		const content = {
			...base,
			count: 7,
			excerpt: "Shipped the fix.",
			group: "Website",
			groupKind: "project" as const,
		};
		for (const kind of GALLERY_COVER_KINDS) {
			const markup = renderToStaticMarkup(
				<GalleryCover cover={{ ...content, kind }} />
			);
			expect(markup).toContain(`data-cover="${kind}"`);
			expect(markup).toContain('aria-hidden="true"');
			expect(markup).not.toContain("NaN");
		}
		expect(
			renderToStaticMarkup(
				<GalleryCover cover={{ ...content, kind: "quote" }} />
			)
		).toContain("Shipped the fix.");
		expect(
			renderToStaticMarkup(
				<GalleryCover cover={{ ...content, kind: "poster" }} />
			)
		).toContain("Website");
	});

	test("a ratio override re-frames the cover", () => {
		if (!base) {
			throw new Error("fixture has threads");
		}
		const cover = { ...base, ratio: 1.5 };
		expect(renderToStaticMarkup(<GalleryCover cover={cover} />)).toContain(
			"aspect-ratio:1 / 1.5000"
		);
		expect(
			renderToStaticMarkup(<GalleryCover cover={cover} ratio={0.75} />)
		).toContain("aspect-ratio:1 / 0.7500");
	});
});

describe("GalleryInterface", () => {
	test("renders loading, empty and board states", () => {
		const empty = { ...SNAPSHOT, agents: [], threads: [] };
		const loading = render({ loading: true, snapshot: empty });
		expect(loading).toContain('data-testid="interface-gallery"');
		expect(loading).toContain('aria-busy="true"');
		expect(render({ snapshot: empty })).toContain("No conversations yet");

		const board = render();
		expect(board).toContain('aria-label="Conversations"');
		expect(board).toContain('aria-label="Search conversations"');
		expect(board).toContain("Needs attention");
		expect(board).toContain("Run failed");
		expect(board).toContain('aria-label="Message Ada"');
	});

	test("an open thread shows the pin page beside the host view", () => {
		const markup = render({
			activeThreadId: "thread-notes",
			threadView: <div data-testid="host-thread-view">Host</div>,
		});
		expect(markup).toContain('data-testid="gallery-thread-view"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Conversation details"');
		expect(markup).toContain("More like this");
		expect(markup).toContain("Website");
		expect(markup).toContain('aria-label="Back to gallery"');
	});

	test("cards open threads and quick actions message the agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GalleryInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const card = view.container.querySelector(
			'[data-gallery-card="thread-triage"]'
		);
		await click(card);
		await click(buttonByLabel(view.container, "Message Grace"));
		await click(buttonByLabel(view.container, "New conversation"));
		expect(calls).toEqual([
			"open:thread-triage",
			'start:{"agentId":"agent-grace"}',
			"start:{}",
		]);
		await view.dispose();
	});

	test("chips and search narrow the board, and clear restores it", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<GalleryInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(cardIds(view.container)).toHaveLength(5);

		await click(buttonByLabel(view.container, "Working"));
		expect(cardIds(view.container)).toEqual(["thread-triage"]);
		await click(buttonByLabel(view.container, "All"));

		const ada = buttonByLabel(view.container, "Ada");
		await click(ada);
		expect(ada?.getAttribute("aria-pressed")).toBe("true");
		expect(cardIds(view.container).sort()).toEqual([
			"thread-notes",
			"thread-question",
		]);
		await click(buttonByLabel(view.container, "New conversation"));
		expect(calls).toEqual(['start:{"agentId":"agent-ada"}']);

		await click(buttonByLabel(view.container, "Needs attention"));
		expect(view.container.textContent).toContain("No matches");
		await click(buttonByLabel(view.container, "Clear filters"));
		expect(cardIds(view.container)).toHaveLength(5);
		await view.dispose();
	});

	test("Escape and the back button close the open thread", async () => {
		const calls: string[] = [];
		function Host() {
			const [activeThreadId, setActiveThreadId] = useState<string | null>(
				"thread-triage"
			);
			const port: InterfacePort = {
				closeThread: () => {
					calls.push("close");
					setActiveThreadId(null);
				},
				openThread: (id) => {
					calls.push(`open:${id}`);
					setActiveThreadId(id);
				},
				startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
			};
			return (
				<GalleryInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={{}}
					port={port}
					snapshot={SNAPSHOT}
					threadView={
						activeThreadId ? <div data-testid="host">Host</div> : null
					}
				/>
			);
		}
		const view = await mount(<Host />);
		expect(view.container.querySelector("[data-testid='host']")).not.toBe(null);
		expect(view.container.querySelector("h2")?.textContent).toBe(
			"Crash triage"
		);

		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(calls).toEqual(["close"]);
		expect(view.container.querySelector("[data-testid='host']")).toBe(null);

		const related = view.container.querySelector(
			'[data-gallery-card="thread-flaky"]'
		);
		await click(related);
		await click(buttonByLabel(view.container, "Back to gallery"));
		expect(calls).toEqual(["close", "open:thread-flaky", "close"]);
		await view.dispose();
	});
});
