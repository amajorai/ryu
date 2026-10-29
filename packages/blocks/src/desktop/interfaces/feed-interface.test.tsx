import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { FeedInterface } from "./feed-interface.tsx";
import { feedStatusMarker, needsYou } from "./feed-model.ts";

type ThreadStartInput = Parameters<InterfacePort["startThread"]>[0];

const MINUTE = 60_000;
const BASE = Date.now();
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
	],
	groups: [],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
			messageCount: 4,
			title: "Release notes",
			updatedAt: ago(10),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			title: "Crash triage",
			updatedAt: ago(2),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
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
	],
	version: 1,
};

const EMPTY_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

const THREAD_VIEW = <div data-testid="host-thread-view">Host chat surface</div>;

function recordingPort() {
	const calls = {
		closed: 0,
		opened: [] as string[],
		started: [] as ThreadStartInput[],
	};
	const port: InterfacePort = {
		closeThread: () => {
			calls.closed += 1;
		},
		openThread: (threadId) => {
			calls.opened.push(threadId);
		},
		startThread: (input) => {
			calls.started.push(input);
		},
	};
	return { calls, port };
}

const NOOP_PORT = recordingPort().port;

function feed(
	overrides: Partial<{
		activeThreadId: string | null;
		loading: boolean;
		port: InterfacePort;
		snapshot: InterfaceSnapshot;
		threadView: ReactElement | null;
	}> = {}
) {
	return (
		<FeedInterface
			activeThreadId={overrides.activeThreadId ?? null}
			loading={overrides.loading ?? false}
			params={{ order: "recent" }}
			port={overrides.port ?? NOOP_PORT}
			snapshot={overrides.snapshot ?? SNAPSHOT}
			threadView={overrides.threadView ?? null}
		/>
	);
}

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

/** Type into a controlled field; React may watch `input` or `keyup`. */
async function typeInto(
	input: HTMLInputElement | HTMLTextAreaElement,
	value: string
) {
	const prototype =
		input instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	const setValue = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
	await act(async () => {
		input.focus();
		setValue?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

function postIds(container: HTMLElement): string[] {
	return [
		...container.querySelectorAll<HTMLButtonElement>("button[data-feed-post]"),
	].map((button) => button.dataset.feedPost ?? "");
}

function postArticle(container: HTMLElement, threadId: string): HTMLElement {
	const article = container
		.querySelector(`button[data-feed-post="${threadId}"]`)
		?.closest("article");
	if (!(article instanceof HTMLElement)) {
		throw new Error(`Expected the post for ${threadId}`);
	}
	return article;
}

describe("feed model", () => {
	test("maps thread status to the quiet meta-line marker", () => {
		expect(feedStatusMarker("attention", undefined)?.short).toBe("Failed");
		expect(
			feedStatusMarker(
				"attention",
				thread({ id: "x", runState: "interrupted" })
			)?.long
		).toBe("Run stopped");
		expect(feedStatusMarker("your-turn", undefined)?.short).toBe("Your turn");
		expect(feedStatusMarker("waiting", undefined)?.short).toBe("Waiting");
		expect(feedStatusMarker("working", undefined)).toBeNull();
		expect(feedStatusMarker("quiet", undefined)).toBeNull();
	});

	test("needs you covers failed runs and unanswered replies only", () => {
		expect(needsYou("attention")).toBe(true);
		expect(needsYou("your-turn")).toBe(true);
		expect(needsYou("working")).toBe(false);
		expect(needsYou("waiting")).toBe(false);
		expect(needsYou("quiet")).toBe(false);
	});
});

describe("FeedInterface", () => {
	test("renders every thread as a post, newest first", async () => {
		const { container, dispose } = await mount(feed());
		try {
			expect(
				container.querySelector('[data-testid="interface-feed"]')
			).not.toBeNull();
			expect(postIds(container)).toEqual([
				"thread-triage",
				"thread-notes",
				"thread-flaky",
				"thread-question",
			]);
			expect(container.textContent).toContain("Release notes");
			expect(container.textContent).toContain("@ada");
			expect(
				container.querySelector('[aria-label="Post and replies"]')
			).toBeNull();
		} finally {
			await dispose();
		}
	});

	test("marks failed, your-turn, waiting and live posts in the meta line", async () => {
		const { container, dispose } = await mount(feed());
		try {
			const failed = postArticle(container, "thread-flaky");
			expect(failed.textContent).toContain("Failed");
			expect(failed.querySelector(".text-destructive")?.textContent).toBe(
				"Failed"
			);
			expect(postArticle(container, "thread-notes").textContent).toContain(
				"Your turn"
			);
			expect(postArticle(container, "thread-question").textContent).toContain(
				"Waiting"
			);
			const live = postArticle(container, "thread-triage");
			expect(live.textContent).toContain("Live");
			expect(live.textContent).not.toContain("Your turn");
		} finally {
			await dispose();
		}
	});

	test("the post page shows the host thread view and the run state", () => {
		const html = renderToStaticMarkup(
			feed({ activeThreadId: "thread-flaky", threadView: THREAD_VIEW })
		);

		expect(html).toContain('aria-label="Post and replies"');
		expect(html).toContain('aria-label="Back to feed"');
		expect(html).toContain('data-testid="host-thread-view"');
		expect(html).toContain("Run failed");
	});

	test("back goes through the port", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(
			feed({ activeThreadId: "thread-notes", port, threadView: THREAD_VIEW })
		);
		try {
			await click(container.querySelector('button[aria-label="Back to feed"]'));
			expect(calls.closed).toBe(1);
		} finally {
			await dispose();
		}
	});

	test("renders an empty timeline", () => {
		const html = renderToStaticMarkup(feed({ snapshot: EMPTY_SNAPSHOT }));

		expect(html).toContain("Nothing here yet");
		expect(html).toContain("Write your first post");
		expect(html).not.toContain("Welcome");
	});

	test("loading shows post-shaped skeleton rows", () => {
		const html = renderToStaticMarkup(
			feed({ loading: true, snapshot: EMPTY_SNAPSHOT })
		);

		expect(html).toContain('aria-label="Loading posts"');
		expect(html.match(/data-feed-skeleton/g)).toHaveLength(4);
		expect(html).not.toContain("Nothing here yet");
	});

	test("search narrows the timeline and clears", async () => {
		const { container, dispose } = await mount(feed());
		try {
			const search = container.querySelector<HTMLInputElement>(
				'input[type="search"]'
			);
			if (!search) {
				throw new Error("Expected the feed search field");
			}
			await typeInto(search, "crash");
			expect(postIds(container)).toEqual(["thread-triage"]);
			expect(container.textContent).toContain("Results for");

			await typeInto(search, "no such post");
			expect(postIds(container)).toEqual([]);
			expect(container.textContent).toContain("No results for");

			await click(container.querySelector('button[aria-label="Clear search"]'));
			expect(postIds(container)).toHaveLength(4);
		} finally {
			await dispose();
		}
	});

	test("the Needs you tab keeps failed runs and replies to read", async () => {
		const { container, dispose } = await mount(feed());
		try {
			await click(
				container.querySelector('[role="tab"][data-tab="needs-you"]')
			);
			expect(postIds(container)).toEqual(["thread-notes", "thread-flaky"]);
		} finally {
			await dispose();
		}
	});

	test("the Working view lists only running threads", async () => {
		const { container, dispose } = await mount(feed());
		try {
			const working = [
				...container.querySelectorAll<HTMLButtonElement>("button"),
			].find((button) =>
				button.getAttribute("aria-label")?.startsWith("Working,")
			);
			await click(working);
			expect(postIds(container)).toEqual(["thread-triage"]);
			expect(container.textContent).not.toContain("2 posts");
		} finally {
			await dispose();
		}
	});

	test("opening a post and messaging an agent go through the port", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(feed({ port }));
		try {
			await click(
				container.querySelector('button[data-feed-post="thread-notes"]')
			);
			await click(container.querySelector('button[aria-label="Message Ada"]'));

			expect(calls.opened).toEqual(["thread-notes"]);
			expect(calls.started).toEqual([{ agentId: "agent-ada" }]);
		} finally {
			await dispose();
		}
	});

	test("the composer sends a prompt only on an explicit submit", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(feed({ port }));
		try {
			const field = container.querySelector<HTMLTextAreaElement>("textarea");
			if (!field) {
				throw new Error("Expected the composer field");
			}
			await typeInto(field, "  Summarise the launch  ");
			expect(calls.started).toEqual([]);

			// Plain Enter is a newline, not a send.
			await act(async () => {
				field.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
				);
			});
			expect(calls.started).toEqual([]);

			const form = field.closest("form");
			await act(async () => {
				form?.requestSubmit();
			});
			expect(calls.started).toEqual([
				{ agentId: "agent-ada", prompt: "Summarise the launch" },
			]);
			expect(field.value).toBe("");
		} finally {
			await dispose();
		}
	});

	test("an empty composer never sends", async () => {
		const { calls, port } = recordingPort();
		const { container, dispose } = await mount(feed({ port }));
		try {
			const form = container.querySelector("form");
			await act(async () => {
				form?.requestSubmit();
			});
			expect(calls.started).toEqual([]);
		} finally {
			await dispose();
		}
	});
});
