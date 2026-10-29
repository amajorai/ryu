import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { MotionGlobalConfig } from "motion/react";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { CinemaInterface } from "./cinema-interface.tsx";
import {
	cinemaArt,
	cinemaCardWidth,
	cinemaCollection,
	cinemaFeatured,
	cinemaNames,
	cinemaPages,
	cinemaPerRow,
	cinemaRelated,
	cinemaRowFeatured,
	cinemaRowFit,
	cinemaRows,
	cinemaSearch,
	cinemaTitles,
} from "./cinema-model.ts";
import { cinemaPreviewBox } from "./cinema-preview.tsx";

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
			messageCount: 6,
			pinned: true,
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
			messageCount: 12,
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
// Exit animations finish at once, so closed layers leave the DOM in-step.
MotionGlobalConfig.skipAnimations = true;
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

/** Roots still mounted, so a failing test cannot leak running animations. */
const mounted = new Set<() => Promise<void>>();
afterEach(async () => {
	for (const dispose of mounted) {
		await dispose();
	}
});

async function mount(element: ReactElement) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => root.render(element));
	const dispose = async () => {
		if (!mounted.delete(dispose)) {
			return;
		}
		await act(async () => root.unmount());
		container.remove();
	};
	mounted.add(dispose);
	return { container, dispose };
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function buttonNamed(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
	);
}

/**
 * Types into a controlled field the way React's onChange observes it. React
 * may have been evaluated before the DOM was registered, in which case it
 * watches the focused field's keyup instead of `input`, so send both.
 */
async function typeInto(field: HTMLInputElement, value: string) {
	let proto: object | null = Object.getPrototypeOf(field);
	let setValue: ((this: HTMLInputElement, next: string) => void) | undefined;
	while (proto && !setValue) {
		setValue = Object.getOwnPropertyDescriptor(proto, "value")?.set;
		proto = Object.getPrototypeOf(proto);
	}
	await act(async () => {
		field.focus();
		setValue?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
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
	overrides: Partial<Parameters<typeof CinemaInterface>[0]> = {}
): string {
	const { port } = recordingPort();
	return renderToStaticMarkup(
		<CinemaInterface
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

describe("cinema model", () => {
	test("features the live thread, else your turn, else the newest", () => {
		const titles = cinemaTitles(SNAPSHOT);
		expect(cinemaFeatured(titles)?.thread.id).toBe("thread-triage");
		const calm = cinemaTitles({
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter((item) => !item.running),
		});
		expect(cinemaFeatured(calm)?.thread.id).toBe("thread-notes");
		expect(cinemaFeatured([])).toBe(null);
	});

	test("shelves rows in order and leaves empty ones out", () => {
		const rows = cinemaRows(SNAPSHOT);
		expect(rows.map((row) => row.id)).toEqual([
			"continue",
			"live",
			"attention",
			"recent",
			"top",
			"list",
			"agent:agent-grace",
			"agent:agent-ada",
		]);
		expect(rows.map((row) => row.title)).toContain("With Grace");
		const top = rows.find((row) => row.id === "top");
		expect(top?.layout).toBe("top");
		expect(top?.titles[0]?.thread.id).toBe("thread-triage");
		expect(
			cinemaCollection(SNAPSHOT, "continue").map((title) => title.thread.id)
		).toEqual(["thread-notes"]);
	});

	test("art is deterministic per id and searches match every word", () => {
		expect(cinemaArt("thread-notes")).toEqual(cinemaArt("thread-notes"));
		const titles = cinemaTitles(SNAPSHOT);
		expect(
			cinemaSearch(titles, "grace crash").map((title) => title.thread.id)
		).toEqual(["thread-triage"]);
		expect(cinemaSearch(titles, "website").length).toBe(2);
		expect(cinemaSearch(titles, "   ")).toEqual([]);
	});

	test("related titles share an agent first, then the project", () => {
		const titles = cinemaTitles(SNAPSHOT);
		expect(
			cinemaRelated(titles, "thread-notes", 6).map((title) => title.thread.id)
		).toEqual(["thread-question", "thread-triage"]);
	});

	test("short rows fill the frame instead of stopping partway", () => {
		expect(cinemaRowFit(9, 6)).toBe(6);
		expect(cinemaRowFit(5, 6)).toBe(5);
		expect(cinemaRowFit(3, 6)).toBe(3);
		expect(cinemaRowFeatured(2, 6)).toBe(true);
		expect(cinemaRowFeatured(1, 4)).toBe(true);
		expect(cinemaRowFeatured(3, 6)).toBe(false);
		expect(cinemaRowFeatured(1, 3)).toBe(false);
	});

	test("rows size their posters to the frame on the 4px grid", () => {
		expect(cinemaPerRow(1344)).toBe(6);
		expect(cinemaPerRow(800)).toBe(4);
		expect(cinemaPerRow(358)).toBe(2);
		expect(cinemaCardWidth(1344, 6)).toBe(217);
		expect(cinemaPages(10, 4, 0, 900)).toEqual({ count: 3, current: 0 });
		expect(cinemaPages(10, 4, 1800, 900)).toEqual({ count: 3, current: 2 });
		expect(cinemaNames(SNAPSHOT.agents)).toBe("Ada, Grace and Linus");
	});

	test("the preview grows over its poster and stays inside the gutters", () => {
		const middle = cinemaPreviewBox(
			{ height: 122, left: 500, top: 400, width: 217 },
			1440,
			900,
			48
		);
		expect(middle.width).toBe(326);
		expect(middle.left).toBe(Math.round(500 + 217 / 2 - 326 / 2));
		const first = cinemaPreviewBox(
			{ height: 122, left: 48, top: 400, width: 217 },
			1440,
			900,
			48
		);
		expect(first.left).toBe(48);
		expect(first.originX).toBeLessThan(0.5);
		const last = cinemaPreviewBox(
			{ height: 122, left: 1175, top: 400, width: 217 },
			1440,
			900,
			48
		);
		expect(last.left + last.width).toBe(1392);
	});
});

describe("CinemaInterface", () => {
	test("renders the skeleton while loading and an invitation when empty", () => {
		const loading = render({ loading: true });
		expect(loading).toContain('data-testid="interface-cinema"');
		expect(loading).toContain('aria-busy="true"');
		const empty = render({ snapshot: { ...SNAPSHOT, threads: [] } });
		expect(empty).toContain("Nothing showing yet");
		expect(empty).toContain("Linus");
	});

	test("features the live thread on the billboard and shelves the rows", () => {
		const markup = render();
		expect(markup).toContain('data-testid="cinema-billboard"');
		expect(markup).toContain('aria-label="Featured: Crash triage"');
		expect(markup).toContain("Looking at the crash reports now.");
		for (const heading of [
			"Continue",
			"Live now",
			"Needs attention",
			"Recently updated",
			"Most active",
			"Pinned",
			"With Grace",
			"With Ada",
		]) {
			expect(markup).toContain(heading);
		}
		expect(markup).not.toContain('data-testid="cinema-thread-panel"');
	});

	test("shows the host thread view in a full-height panel", () => {
		const markup = render({
			activeThreadId: "thread-triage",
			threadView: <div data-testid="host-thread-view">Host</div>,
		});
		expect(markup).toContain('data-testid="cinema-thread-panel"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Thread: Crash triage"');
		expect(markup).toContain('aria-current="true"');
	});

	test("Open, More info, and the details modal act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<CinemaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(buttonNamed(view.container, "Open"));
		expect(calls).toEqual(["open:thread-triage"]);

		await click(buttonNamed(view.container, "More info"));
		const dialog = view.container.querySelector('[role="dialog"]');
		expect(dialog?.textContent).toContain("Crash triage");
		expect(dialog?.textContent).toContain("More like this");
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");

		await click(buttonNamed(view.container, "More info: Flaky test"));
		expect(
			view.container.querySelector('[role="dialog"] h2')?.textContent
		).toBe("Flaky test");
		await click(buttonNamed(view.container, "New thread with Grace"));
		expect(calls.at(-1)).toBe('start:{"agentId":"agent-grace"}');
		expect(view.container.querySelector('[role="dialog"]')).toBe(null);

		const poster = view.container.querySelector(
			'[data-cinema-thread="thread-loose"]'
		);
		await click(poster);
		expect(
			view.container.querySelector('[role="dialog"] h2')?.textContent
		).toBe("Loose ends");
		await click(buttonNamed(view.container, "Close"));
		expect(view.container.querySelector('[role="dialog"]')).toBe(null);
		expect(document.activeElement).toBe(poster);
		await view.dispose();
	});

	test("row titles open a collection page, and search narrows to a grid", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<CinemaInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const heading = [...view.container.querySelectorAll("h2 button")].find(
			(item) => item.textContent?.startsWith("With Grace")
		);
		await click(heading);
		expect(view.container.querySelector("h1")?.textContent).toBe("With Grace");
		expect(
			[...view.container.querySelectorAll("[data-cinema-thread]")].map((item) =>
				item.getAttribute("data-cinema-thread")
			)
		).toEqual(["thread-triage", "thread-flaky"]);

		await click(buttonNamed(view.container, "Home"));
		expect(
			view.container.querySelector('[data-testid="cinema-billboard"]')
		).not.toBe(null);

		const input = view.container.querySelector("input[type='search']");
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected the search input");
		}
		await typeInto(input, "zzz");
		expect(view.container.textContent).toContain("did not have any matches");
		await view.dispose();
	});

	test("the panel closes through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<CinemaInterface
				activeThreadId="thread-flaky"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host</div>}
			/>
		);
		await click(buttonNamed(view.container, "Close Flaky test"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});
