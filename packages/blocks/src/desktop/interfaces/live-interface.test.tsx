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
import { LiveScene } from "./live-art.tsx";
import { LiveInterface } from "./live-interface.tsx";
import {
	LIVE_ART_KINDS,
	liveAgo,
	liveArt,
	liveCaptionLines,
	liveCategories,
	liveChannels,
	liveFeatured,
	liveSchedule,
	liveSearchCategories,
	liveSearchChannels,
	liveStatusTag,
	liveUnassigned,
	liveUptime,
} from "./live-model.ts";

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
			description: "Deploys and on-call",
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
	events: [
		{
			agentId: "agent-grace",
			id: "event-next",
			kind: "upcoming",
			label: "Daily at 9 AM",
			start: new Date(BASE + 60 * MINUTE).toISOString(),
			title: "Morning deploy check",
		},
		{
			agentId: "agent-grace",
			end: ago(119),
			id: "event-past",
			kind: "past",
			label: "Daily at 9 AM",
			outcome: "failure",
			start: ago(120),
			title: "Morning deploy check",
		},
		{
			agentId: "agent-ada",
			id: "event-ada",
			kind: "upcoming",
			label: null,
			start: new Date(BASE + 30 * MINUTE).toISOString(),
			title: "Weekly digest",
		},
	],
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Website",
		},
		{
			id: "team-ops",
			kind: "team",
			memberAgentIds: ["agent-grace"],
			name: "Ops Crew",
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
			id: "thread-deploy",
			lastMessage: "Canary is at 25% and the error rate is flat.",
			messageCount: 9,
			projectId: "project-site",
			running: true,
			title: "Roll out the gateway",
			updatedAt: ago(5),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			teamId: "team-ops",
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

/** Fixed colours other than the stream art's (which `live-palette.ts` sets in HSL). */
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|rgba?\(|oklch\(/i;

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

/**
 * Types into a controlled field the way React's onChange observes it: React
 * may watch the focused field's keyup instead of `input`, so send both.
 */
async function type(field: HTMLInputElement, value: string) {
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

function byLabel(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === label ||
			candidate.textContent?.trim() === label
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

/** A host that keeps the open thread in state, like the desktop does. */
function Host({
	calls,
	initialThreadId = null,
	snapshot = SNAPSHOT,
}: {
	calls: string[];
	initialThreadId?: string | null;
	snapshot?: InterfaceSnapshot;
}) {
	const [activeThreadId, setActiveThreadId] = useState<string | null>(
		initialThreadId
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
		<LiveInterface
			activeThreadId={activeThreadId}
			loading={false}
			params={{}}
			port={port}
			snapshot={snapshot}
			threadView={
				activeThreadId ? (
					<div data-testid="host-thread-view">Host {activeThreadId}</div>
				) : null
			}
		/>
	);
}

function render(overrides: Partial<Parameters<typeof LiveInterface>[0]> = {}) {
	const { port } = recordingPort();
	return renderToStaticMarkup(
		<LiveInterface
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

describe("live model", () => {
	test("channels put live agents first and stream their running thread", () => {
		const channels = liveChannels(SNAPSHOT);
		expect(channels.map((channel) => channel.agent.name)).toEqual([
			"Grace",
			"Ada",
			"Linus",
		]);
		const [grace, ada, linus] = channels;
		expect(grace?.live).toBe(true);
		expect(grace?.liveCount).toBe(1);
		expect(grace?.current?.id).toBe("thread-deploy");
		expect(grace?.category?.name).toBe("Website");
		expect(ada?.live).toBe(false);
		expect(ada?.current?.id).toBe("thread-notes");
		expect(linus?.current).toBe(null);
		expect(linus?.threads).toEqual([]);
	});

	test("the open thread is featured only on its own channel", () => {
		const [grace] = liveChannels(SNAPSHOT);
		if (!grace) {
			throw new Error("Expected a channel");
		}
		expect(liveFeatured(grace, "thread-flaky")?.id).toBe("thread-flaky");
		expect(liveFeatured(grace, "thread-notes")?.id).toBe("thread-deploy");
		expect(liveFeatured(grace, null)?.id).toBe("thread-deploy");
	});

	test("categories, unassigned threads and search", () => {
		const channels = liveChannels(SNAPSHOT);
		const categories = liveCategories(SNAPSHOT, channels);
		expect(categories.map((entry) => entry.category.name)).toEqual([
			"Website",
			"Ops Crew",
		]);
		expect(categories[0]?.liveCount).toBe(1);
		expect(categories[0]?.channelIds).toEqual(["agent-grace", "agent-ada"]);
		expect(liveUnassigned(SNAPSHOT).map((item) => item.id)).toEqual([
			"thread-loose",
		]);
		const names = (query: string) =>
			liveSearchChannels(channels, query).map((channel) => channel.agent.name);
		expect(names("")).toEqual(["Grace", "Ada", "Linus"]);
		expect(names("  GATEWAY ")).toEqual(["Grace"]);
		expect(names("website")).toEqual(["Grace", "Ada"]);
		expect(names("never")).toEqual(["Linus"]);
		expect(
			liveSearchCategories(categories, "ops").map((entry) => entry.category.id)
		).toEqual(["team-ops"]);
	});

	test("uptime, ages and status tags read like the reference", () => {
		expect(liveUptime(ago(0), BASE)).toBe("0:00:00");
		expect(liveUptime(ago(64.15), BASE)).toBe("1:04:09");
		expect(liveUptime("not a date", BASE)).toBe("0:00:00");
		expect(liveAgo(ago(0.5), BASE)).toBe("Just now");
		expect(liveAgo(ago(1), BASE)).toBe("1 minute ago");
		expect(liveAgo(ago(180), BASE)).toBe("3 hours ago");
		expect(liveAgo(ago(60 * 30), BASE)).toBe("Yesterday");
		expect(liveAgo(ago(60 * 24 * 5), BASE)).toBe("5 days ago");
		const [notes, question, deploy, flaky] = SNAPSHOT.threads;
		expect(notes && liveStatusTag(notes)).toBe("Your turn");
		expect(question && liveStatusTag(question)).toBe("Waiting on agent");
		expect(deploy && liveStatusTag(deploy)).toBe(null);
		expect(flaky && liveStatusTag(flaky)).toBe("Run failed");
		expect(flaky && liveStatusTag({ ...flaky, runState: "interrupted" })).toBe(
			"Interrupted"
		);
	});

	test("captions break on whole words within the line width", () => {
		const text =
			"Canary is at 25% with error rate flat. Promoting to 50% in five minutes unless you say stop.";
		const lines = liveCaptionLines(text, 30);
		expect(lines.join(" ")).toBe(text);
		expect(lines.every((line) => line.length <= 30)).toBe(true);
		expect(liveCaptionLines("   ")).toEqual([]);
		expect(liveCaptionLines("supercalifragilistic", 5)).toEqual([
			"supercalifragilistic",
		]);
	});

	test("art follows the job and stays stable per seed", () => {
		const [ada, grace] = SNAPSHOT.agents;
		const deploy = SNAPSHOT.threads[2] ?? null;
		expect(liveArt(deploy, grace).kind).toBe("chart");
		expect(
			liveArt(thread({ id: "x", title: "Pick a palette" }), ada).kind
		).toBe("canvas");
		expect(
			liveArt(thread({ id: "y", title: "Audit lockfile" }), ada).kind
		).toBe("terminal");
		expect(liveArt(null, ada).kind).toBe("doc");
		expect(liveArt(deploy, grace)).toEqual(liveArt(deploy, grace));
		const kinds = new Set(
			Array.from(
				{ length: 60 },
				(_, index) =>
					liveArt(thread({ id: `t-${index}`, title: "" }), null).kind
			)
		);
		expect(kinds.size).toBe(LIVE_ART_KINDS.length);
	});

	test("schedule lists upcoming runs soonest first, then recent runs", () => {
		const schedule = liveSchedule(SNAPSHOT, "agent-grace");
		expect(schedule.upcoming.map((event) => event.id)).toEqual(["event-next"]);
		expect(schedule.past.map((event) => event.id)).toEqual(["event-past"]);
		expect(liveSchedule(SNAPSHOT, "agent-linus")).toEqual({
			past: [],
			upcoming: [],
		});
	});
});

describe("LiveScene", () => {
	test("every scene shows its segment and the thread's content", () => {
		const spec = {
			excerpt: "Canary is at 25%.",
			hue: 200,
			neutral: false,
			seed: "scene-test",
			speaker: "Grace",
			title: "Roll out gateway",
		};
		for (const kind of LIVE_ART_KINDS) {
			const markup = renderToStaticMarkup(
				<LiveScene spec={{ ...spec, kind }} />
			);
			expect(markup).toContain(`data-art="${kind}"`);
			expect(markup).toContain('aria-hidden="true"');
			expect(markup).toContain("Canary is at 25%.");
			expect(markup).not.toContain("NaN");
		}
		const player = renderToStaticMarkup(
			<LiveScene mode="player" spec={{ ...spec, kind: "chart" }} />
		);
		expect(player).toContain("Roll out gateway");
		expect(player).toContain("Ops");
	});
});

describe("LiveInterface", () => {
	test("renders loading, empty and browse states", () => {
		const empty = { ...SNAPSHOT, agents: [], threads: [] };
		const loading = render({ loading: true, snapshot: empty });
		expect(loading).toContain('data-testid="interface-live"');
		expect(loading).toContain('aria-busy="true"');
		expect(render({ snapshot: empty })).toContain("No channels yet");

		const browse = render();
		expect(browse).toContain('aria-label="Followed channels"');
		expect(browse).toContain('aria-label="Search channels and categories"');
		expect(browse).toContain("Live channels");
		expect(browse).toContain("Offline channels");
		expect(browse).toContain("Without a channel");
		expect(browse).toContain('aria-label="Watch Grace: Roll out the gateway"');
		expect(browse).toContain('aria-label="Grace, live: Roll out the gateway"');
		expect(browse).toContain('aria-label="Linus, offline"');
		expect(browse).not.toContain('data-testid="live-chat"');
		expect(browse).not.toMatch(COLOR_LITERAL);
	});

	test("an open thread shows its channel with the host view as stream chat", () => {
		const markup = render({
			activeThreadId: "thread-deploy",
			threadView: <div data-testid="host-thread-view">Host</div>,
		});
		expect(markup).toContain('data-page="channel"');
		expect(markup).toContain('data-testid="live-chat"');
		expect(markup).toContain("Stream chat");
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain('aria-label="Live stream: Roll out the gateway"');
		expect(markup).toContain('data-live-player="live"');
		expect(markup).toContain('aria-label="Message Grace"');
		expect(markup).toContain("Videos");
		expect(markup).toContain("Flaky test");
	});

	test("a thread with no agent keeps Browse and shows chat beside it", () => {
		const markup = render({
			activeThreadId: "thread-loose",
			threadView: <div data-testid="host-thread-view">Host</div>,
		});
		expect(markup).toContain('data-page="browse"');
		expect(markup).toContain('data-testid="host-thread-view"');
	});

	test("choosing channels opens their stream; Message starts a thread", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		await click(byLabel(view.container, "Watch Grace: Roll out the gateway"));
		expect(
			view.container.querySelector("[data-page]")?.getAttribute("data-page")
		).toBe("channel");
		expect(
			view.container.querySelector("[data-testid='host-thread-view']")
				?.textContent
		).toBe("Host thread-deploy");

		await click(byLabel(view.container, "Open Flaky test, Grace"));
		expect(
			view.container
				.querySelector("[data-live-player]")
				?.getAttribute("data-live-player")
		).toBe("offline");

		await click(byLabel(view.container, "Message Grace"));
		await click(byLabel(view.container, "Ada, offline"));
		expect(calls).toEqual([
			"open:thread-deploy",
			"open:thread-flaky",
			'start:{"agentId":"agent-grace"}',
			"open:thread-notes",
		]);
		await view.dispose();
	});

	test("an agent with no threads gets the empty chat room and a chat box", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-deploy" />
		);
		await click(byLabel(view.container, "Linus, offline"));
		expect(calls).toEqual(["close"]);
		expect(view.container.textContent).toContain("Linus is offline");
		expect(view.container.textContent).toContain("Welcome to the chat room");

		const input = view.container.querySelector<HTMLInputElement>(
			"[data-testid='live-chat'] input"
		);
		if (!input) {
			throw new Error("Expected the chat box");
		}
		await type(input, "  Draft the welcome email  ");
		const send = byLabel(view.container, "Chat");
		expect(send?.hasAttribute("disabled")).toBe(false);
		await act(async () => {
			send?.closest("form")?.requestSubmit(send);
		});
		expect(input.value).toBe("");
		expect(calls).toEqual([
			"close",
			'start:{"agentId":"agent-linus","prompt":"Draft the welcome email"}',
		]);
		await view.dispose();
	});

	test("categories open a directory whose tiles open threads", async () => {
		const calls: string[] = [];
		const view = await mount(<Host calls={calls} />);
		const tab = [...view.container.querySelectorAll("[role='tab']")].find(
			(candidate) => candidate.textContent === "Categories"
		);
		await click(tab);
		expect(tab?.getAttribute("aria-selected")).toBe("true");
		await click(byLabel(view.container, "Ops Crew, 1 video"));
		expect(view.container.querySelector("h1")?.textContent).toBe("Ops Crew");
		await click(byLabel(view.container, "Open Flaky test, Grace"));
		expect(calls).toEqual(["open:thread-flaky"]);
		expect(
			view.container.querySelector("[data-page]")?.getAttribute("data-page")
		).toBe("channel");
		await view.dispose();
	});

	test("Escape and Browse return to the directory and close the thread", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-deploy" />
		);
		expect(
			view.container.querySelector("[data-page]")?.getAttribute("data-page")
		).toBe("channel");
		await act(async () => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(calls).toEqual(["close"]);
		expect(
			view.container.querySelector("[data-page]")?.getAttribute("data-page")
		).toBe("browse");

		await click(byLabel(view.container, "Ada, offline"));
		await click(byLabel(view.container, "Browse"));
		expect(calls).toEqual(["close", "open:thread-notes", "close"]);
		expect(view.container.querySelector("[data-testid='live-chat']")).toBe(
			null
		);
		await view.dispose();
	});

	test("the rail collapses to faces and the chat column collapses", async () => {
		const calls: string[] = [];
		const view = await mount(
			<Host calls={calls} initialThreadId="thread-deploy" />
		);
		await click(byLabel(view.container, "Collapse followed channels"));
		expect(
			view.container
				.querySelector("nav[aria-label='Followed channels']")
				?.getAttribute("data-collapsed")
		).toBe("true");
		await click(byLabel(view.container, "Collapse chat"));
		expect(view.container.querySelector("[data-testid='live-chat']")).toBe(
			null
		);
		await click(byLabel(view.container, "Expand chat"));
		expect(view.container.querySelector("[data-testid='live-chat']")).not.toBe(
			null
		);
		expect(calls).toEqual([]);
		await view.dispose();
	});
});
