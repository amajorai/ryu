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
import { MessengerInterface } from "./messenger-interface.tsx";
import {
	entryForThread,
	filterMessengerEntries,
	matchRecipients,
	projectMessengerEntries,
	searchHit,
	typingLabel,
	UNASSIGNED_KEY,
} from "./messenger-model.ts";

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
			id: "team-design",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Design Review",
		},
	],
	threads: [
		thread({
			agentIds: ["agent-ada"],
			id: "thread-notes",
			lastMessage: "Draft is ready for review.",
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
			running: true,
			title: "Crash triage",
			updatedAt: ago(5),
		}),
		thread({
			id: "thread-orphan",
			lastMessage: "Office is closed Friday.",
			lastMessageRole: "user",
			title: "Office closed",
			updatedAt: ago(600),
		}),
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-review",
			lastMessage: "Review done.",
			runState: "failed",
			teamId: "team-design",
			title: "Design review",
			updatedAt: ago(10),
		}),
	],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// happy-dom has no Web Animations API; the scroll area asks for it on mount.
if (typeof Element.prototype.getAnimations !== "function") {
	Element.prototype.getAnimations = () => [];
}
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

function recordingPort() {
	const calls: string[] = [];
	const port: InterfacePort = {
		closeThread: () => calls.push("close"),
		openThread: (id) => calls.push(`open:${id}`),
		startThread: (input) => calls.push(`start:${JSON.stringify(input)}`),
	};
	return { calls, port };
}

describe("messenger model", () => {
	test("lists agents and teams by most recent conversation", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		expect(entries.map((entry) => entry.key)).toEqual([
			"agent:agent-grace",
			"team:team-design",
			"agent:agent-ada",
			UNASSIGNED_KEY,
			"agent:agent-linus",
		]);
		const team = entries.find((entry) => entry.kind === "team");
		expect(team?.threadIds).toEqual(["thread-review"]);
		expect(team?.attention).toBe(1);
	});

	test("keeps team threads out of members' direct messages", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		const ada = entries.find((entry) => entry.key === "agent:agent-ada");
		expect(ada?.threadIds).toEqual(["thread-notes", "thread-question"]);
		expect(ada?.lastThreadId).toBe("thread-notes");
		expect(ada?.unread).toBe(1);
		expect(ada?.attention).toBe(0);
		const grace = entries.find((entry) => entry.key === "agent:agent-grace");
		expect(grace?.threadIds).toEqual(["thread-triage"]);
	});

	test("derives typing from the contact's own threads", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		const grace = entries.find((entry) => entry.key === "agent:agent-grace");
		expect(grace?.running).toBe(true);
		expect(grace?.working.map((agent) => agent.name)).toEqual(["Grace"]);
		// Grace is working, but in her own thread, not the team's.
		const team = entries.find((entry) => entry.kind === "team");
		expect(team?.running).toBe(false);
		expect(team?.working).toEqual([]);
	});

	test("collects threads nobody owns under Unassigned", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		const other = entries.find((entry) => entry.key === UNASSIGNED_KEY);
		expect(other?.threadIds).toEqual(["thread-orphan"]);
		expect(other?.lastMessageRole).toBe("user");
		const withoutOrphans = projectMessengerEntries({
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-orphan"),
		});
		expect(
			withoutOrphans.some((entry) => entry.key === UNASSIGNED_KEY)
		).toBeFalse();
	});

	test("filters on name, description, last message and thread titles", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		expect(
			filterMessengerEntries(entries, "crash").map((entry) => entry.name)
		).toEqual(["Grace"]);
		expect(
			filterMessengerEntries(entries, "  RELEASE ").map((entry) => entry.name)
		).toEqual(["Ada"]);
		expect(
			filterMessengerEntries(entries, "intro edits").map((entry) => entry.name)
		).toEqual(["Ada"]);
		expect(filterMessengerEntries(entries, "")).toHaveLength(entries.length);
	});

	test("points a title-only match at that conversation", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		const ada = entries.find((entry) => entry.key === "agent:agent-ada");
		if (!ada) {
			throw new Error("Ada missing");
		}
		expect(searchHit(ada, "intro")).toEqual({
			threadId: "thread-question",
			title: "Intro edits",
		});
		// A match on the contact itself keeps the normal preview.
		expect(searchHit(ada, "ada")).toBeNull();
		expect(searchHit(ada, "")).toBeNull();
	});

	test("resolves the contact that owns a thread", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		const review = SNAPSHOT.threads.find((item) => item.id === "thread-review");
		expect(entryForThread(entries, review, null)?.key).toBe("team:team-design");
		// Ada's direct messages no longer hold the team thread.
		expect(entryForThread(entries, review, "agent:agent-ada")?.key).toBe(
			"team:team-design"
		);
		const orphan = SNAPSHOT.threads.find((item) => item.id === "thread-orphan");
		expect(entryForThread(entries, orphan, null)?.key).toBe(UNASSIGNED_KEY);
		expect(entryForThread(entries, undefined, null)).toBeUndefined();
	});

	test("sorts pinned chats above more recent ones", () => {
		const entries = projectMessengerEntries({
			...SNAPSHOT,
			threads: SNAPSHOT.threads.map((item) =>
				item.id === "thread-orphan" ? { ...item, pinned: true } : item
			),
		});
		expect(entries[0]?.key).toBe(UNASSIGNED_KEY);
		expect(entries[0]?.pinned).toBeTrue();
		expect(entries.slice(1).some((entry) => entry.pinned)).toBeFalse();
	});

	test("ranks recipients whose name starts with the query first", () => {
		const entries = projectMessengerEntries(SNAPSHOT);
		expect(matchRecipients(entries, " DES").map((entry) => entry.name)).toEqual(
			["Design Review"]
		);
		expect(
			matchRecipients(entries, "release").map((entry) => entry.name)
		).toEqual(["Ada"]);
		expect(matchRecipients(entries, "zz").map((entry) => entry.name)).toEqual(
			[]
		);
		expect(matchRecipients(entries, "")).toHaveLength(entries.length);
	});

	test("names who is typing", () => {
		const [ada, grace, linus] = SNAPSHOT.agents;
		expect(typingLabel([])).toBe("");
		expect(typingLabel(grace ? [grace] : [])).toBe("Grace is typing");
		expect(
			typingLabel([ada, grace, linus].filter((agent) => agent !== undefined))
		).toBe("3 members are typing");
	});
});

describe("MessengerInterface", () => {
	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const loadingMarkup = renderToStaticMarkup(
			<MessengerInterface
				activeThreadId={null}
				loading
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], groups: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(loadingMarkup).toContain('data-testid="interface-messenger"');
		expect(loadingMarkup).toContain('aria-busy="true"');
		expect(loadingMarkup).toContain("Loading conversations");
		expect(loadingMarkup).not.toContain("Create an agent to start messaging");
		const emptyMarkup = renderToStaticMarkup(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], groups: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(emptyMarkup).toContain("No contacts yet");
		expect(emptyMarkup).toContain("Create an agent to start messaging");
	});

	test("shows the host thread view with the contact header", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<MessengerInterface
				activeThreadId="thread-triage"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div data-testid="host-thread-view">Host</div>}
			/>
		);
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain("Conversation with Grace");
		expect(markup).toContain("typing");
		expect(markup).not.toContain("typing…");
	});

	test("a wide window opens the most recent conversation once on load", async () => {
		const { calls, port } = recordingPort();
		const width = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"clientWidth"
		);
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get: () => 1440,
		});
		try {
			const view = await mount(
				<MessengerInterface
					activeThreadId={null}
					loading={false}
					params={{}}
					port={port}
					snapshot={SNAPSHOT}
					threadView={null}
				/>
			);
			const latest = projectMessengerEntries(SNAPSHOT).find(
				(entry) => entry.lastThreadId
			);
			expect(calls).toEqual([`open:${latest?.lastThreadId}`]);
			await view.dispose();
		} finally {
			if (width) {
				Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
			}
		}
	});

	test("a page the host shows over the messenger keeps the first load from opening a thread", async () => {
		const { calls, port } = recordingPort();
		const width = Object.getOwnPropertyDescriptor(
			HTMLElement.prototype,
			"clientWidth"
		);
		Object.defineProperty(HTMLElement.prototype, "clientWidth", {
			configurable: true,
			get: () => 1440,
		});
		// The host keeps the interface mounted under an inert cover.
		const container = document.createElement("div");
		container.setAttribute("inert", "");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () =>
				root.render(
					<MessengerInterface
						activeThreadId={null}
						loading={false}
						params={{}}
						port={port}
						snapshot={SNAPSHOT}
						threadView={null}
					/>
				)
			);
			expect(calls).toEqual([]);
		} finally {
			await act(async () => root.unmount());
			container.remove();
			if (width) {
				Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
			}
		}
	});

	test("selecting contacts opens their latest thread or an empty conversation", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(
			view.container.querySelector('[data-messenger-contact="agent:agent-ada"]')
		);
		expect(calls).toEqual(["open:thread-notes"]);

		await click(
			view.container.querySelector(
				'[data-messenger-contact="agent:agent-linus"]'
			)
		);
		// Nothing was open, so nothing to close; the empty conversation shows.
		expect(calls).toEqual(["open:thread-notes"]);
		expect(view.container.textContent).toContain(
			"This is the start of your conversation with Linus."
		);
		await click(
			view.container.querySelector('[aria-label="New conversation with Linus"]')
		);
		expect(calls.at(-1)).toBe('start:{"agentId":"agent-linus"}');
		await view.dispose();
	});

	test("unread rows show a dot and keep the preview out of the name", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const ada = view.container.querySelector(
			'[data-messenger-contact="agent:agent-ada"]'
		);
		expect(
			ada?.querySelector('[data-testid="messenger-unread"]')
		).not.toBeNull();
		const label = ada?.getAttribute("aria-label") ?? "";
		expect(label).toContain("1 reply waiting on you");
		expect(label).not.toContain("Draft is ready for review.");
		const previewId = ada?.getAttribute("aria-describedby") ?? "";
		expect(
			view.container.querySelector(`[id="${previewId}"]`)?.textContent
		).toBe("Draft is ready for review.");
		await view.dispose();

		// The open conversation reads as read: no dot on the selected row.
		const opened = renderToStaticMarkup(
			<MessengerInterface
				activeThreadId="thread-notes"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host</div>}
			/>
		);
		expect(opened.match(/data-testid="messenger-unread"/g)).toBeNull();
	});

	test("contact rows are a single tab stop on the selected row", async () => {
		const { port } = recordingPort();
		const view = await mount(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		const tabStops = () =>
			Array.from(view.container.querySelectorAll("[data-messenger-contact]"))
				.filter((row) => row.getAttribute("tabindex") === "0")
				.map((row) => row.getAttribute("data-messenger-contact"));
		expect(tabStops()).toEqual(["agent:agent-grace"]);
		await click(
			view.container.querySelector(
				'[data-messenger-contact="agent:agent-linus"]'
			)
		);
		expect(tabStops()).toEqual(["agent:agent-linus"]);
		await view.dispose();
	});

	test("a thread opened elsewhere replaces an unsent new message", async () => {
		const { port } = recordingPort();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (activeThreadId: string | null) =>
			act(async () =>
				root.render(
					<MessengerInterface
						activeThreadId={activeThreadId}
						loading={false}
						params={{}}
						port={port}
						snapshot={SNAPSHOT}
						threadView={
							activeThreadId ? (
								<div data-testid="host-thread-view">Host</div>
							) : null
						}
					/>
				)
			);
		await render(null);
		await click(container.querySelector('[aria-label="New message"]'));
		expect(container.querySelector('[role="combobox"]')).not.toBeNull();
		await render("thread-notes");
		expect(container.querySelector('[role="combobox"]')).toBeNull();
		expect(
			container.querySelector('[data-testid="host-thread-view"]')
		).not.toBeNull();
		await act(async () => root.unmount());
		container.remove();
	});

	test("presence follows the open conversation, not the agent", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<MessengerInterface
				activeThreadId="thread-review"
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={<div>Host</div>}
			/>
		);
		expect(markup).toContain("Conversation with Design Review");
		expect(markup).not.toContain("is typing");
	});

	test("Unassigned opens its threads but cannot start new ones", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(
			view.container.querySelector(
				`[data-messenger-contact="${UNASSIGNED_KEY}"]`
			)
		);
		expect(calls).toEqual(["open:thread-orphan"]);
		await view.dispose();

		const opened = renderToStaticMarkup(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={{ ...SNAPSHOT, threads: [] }}
				threadView={null}
			/>
		);
		expect(opened).not.toContain("Unassigned");
	});

	test("the To: field picks one recipient from a typeahead list", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<MessengerInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(view.container.querySelector('[aria-label="New message"]'));
		const field = view.container.querySelector('[role="combobox"]');
		expect(field?.getAttribute("aria-expanded")).toBe("true");
		const options = () =>
			Array.from(view.container.querySelectorAll('[role="option"]'));
		const activeName = () =>
			view.container
				.querySelector(`[id="${field?.getAttribute("aria-activedescendant")}"]`)
				?.getAttribute("data-recipient");
		expect(options()).toHaveLength(4);
		expect(options().map((option) => option.textContent)).not.toContain(
			"Unassigned"
		);
		expect(activeName()).toBe(options()[0]?.getAttribute("data-recipient"));
		const press = async (key: string) => {
			await act(async () => {
				field?.dispatchEvent(
					new KeyboardEvent("keydown", { bubbles: true, key })
				);
			});
		};
		await press("ArrowUp");
		expect(activeName()).toBe(options().at(-1)?.getAttribute("data-recipient"));
		await press("ArrowDown");
		await press("ArrowDown");
		const second = options()[1]?.getAttribute("data-recipient");
		expect(activeName()).toBe(second);
		await press("Enter");
		expect(view.container.querySelector('[role="listbox"]')).toBeNull();
		expect(field?.getAttribute("aria-expanded")).toBe("false");
		const chip = view.container.querySelector(
			'[data-testid="messenger-recipient"]'
		);
		expect(chip).not.toBeNull();
		expect(view.container.textContent).toContain(
			"This is the start of your conversation with"
		);
		await press("Backspace");
		expect(
			view.container.querySelector('[data-testid="messenger-recipient"]')
		).toBeNull();
		expect(options()).toHaveLength(4);
		// Picking never sends anything by itself.
		expect(calls).toEqual([]);
		await view.dispose();
	});
});
