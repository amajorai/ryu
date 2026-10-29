import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	setSystemTime,
	test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { HubInterface } from "./hub-interface.tsx";
import {
	HUB_CARDS,
	hubAgentLive,
	hubAgentRuns,
	hubAgo,
	hubArt,
	hubClock,
	hubClockDateTime,
	hubComposeAgents,
	hubCounts,
	hubFailedRuns,
	hubGlyph,
	hubGlyphCount,
	hubGlyphLabel,
	hubKeyAction,
	hubNameList,
	hubNextRunHeadline,
	hubRunWhen,
	hubSeed,
	hubStatusLine,
	hubStatusParts,
	hubThreads,
	hubTopicPrompt,
	hubUpcoming,
	hubWithFailedRuns,
	stepHubCard,
} from "./hub-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = new Date(2026, 9, 14, 10, 0, 0).getTime();
const ago = (minutes: number) =>
	new Date(BASE - minutes * MINUTE).toISOString();
const ahead = (minutes: number) =>
	new Date(BASE + minutes * MINUTE).toISOString();

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

const EVENTS: InterfaceEvent[] = [
	{
		agentId: "agent-ada",
		id: "run-digest",
		kind: "upcoming",
		label: "Daily",
		start: ahead(40),
		title: "Morning digest",
	},
	{
		agentId: "agent-grace",
		id: "run-sweep",
		kind: "upcoming",
		label: "Hourly",
		start: ahead(15),
		title: "Inbox sweep",
	},
	{
		agentId: "agent-grace",
		id: "run-old",
		kind: "past",
		label: "Nightly",
		outcome: "failure",
		start: ago(300),
		title: "Dependency audit",
	},
	{
		agentId: "agent-ada",
		id: "run-ok",
		kind: "past",
		label: "Nightly",
		outcome: "success",
		start: ago(200),
		title: "Backup",
	},
];

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
			description: "Reviews code",
			id: "agent-linus",
			name: "Linus",
			status: "idle",
		},
	],
	events: EVENTS,
	groups: [],
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
			id: "thread-pinned",
			lastMessage: "Which logo should I use?",
			pinned: true,
			title: "Logo choice",
			updatedAt: ago(300),
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
			updatedAt: ago(120),
		}),
		thread({
			agentIds: ["agent-linus"],
			id: "thread-question",
			lastMessage: "Can you shorten the intro?",
			lastMessageRole: "user",
			title: "Intro edits",
			updatedAt: ago(90),
		}),
	],
	version: 1,
};

const EMPTY: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
// A test that pins the wall clock must not leak it into the next one.
afterEach(() => {
	setSystemTime();
});
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
		async rerender(next: ReactElement) {
			await act(async () => root.render(next));
		},
	};
}

function button(container: HTMLElement, label: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) => candidate.getAttribute("aria-label") === label
	);
}

async function click(element: Element | null | undefined) {
	if (!(element instanceof HTMLElement)) {
		throw new Error("Expected a clickable element");
	}
	await act(async () => element.click());
}

async function press(key: string, target: EventTarget = document.body) {
	await act(async () => {
		target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key }));
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

function hub(
	port: InterfacePort,
	overrides: Partial<Parameters<typeof HubInterface>[0]> = {}
) {
	return (
		<HubInterface
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

async function typeAndSend(container: HTMLElement, text: string) {
	const field = container.querySelector("textarea");
	if (!(field instanceof HTMLTextAreaElement)) {
		throw new Error("Expected the composer field");
	}
	await act(async () => {
		const setter = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value"
		)?.set;
		field.focus();
		setter?.call(field, text);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		// happy-dom has no native input event support; React reads keyup.
		field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
	});
	await act(async () => {
		field.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
		);
	});
}

function state(container: HTMLElement) {
	return container
		.querySelector('[data-testid="interface-hub"]')
		?.getAttribute("data-state");
}

describe("hub model", () => {
	test("counts threads by status and leads the line with what needs you", () => {
		const counts = hubCounts(SNAPSHOT);
		expect(counts).toEqual({
			attention: 1,
			quiet: 0,
			waiting: 1,
			working: 1,
			"your-turn": 2,
		});
		expect(hubStatusLine(counts, SNAPSHOT)).toBe(
			"1 needs attention · 1 working · 2 waiting on you"
		);
		// The ambient line leaves out what its glyph already shows.
		expect(hubStatusLine(counts, SNAPSHOT, "attention")).toBe(
			"1 working · 2 waiting on you"
		);
		const onlyFailed = {
			...SNAPSHOT,
			threads: SNAPSHOT.threads.filter((item) => item.id === "thread-flaky"),
		};
		expect(hubStatusLine(hubCounts(onlyFailed), onlyFailed, "attention")).toBe(
			"Nothing else waiting"
		);
		expect(hubStatusLine(hubCounts(EMPTY), EMPTY)).toBe("No agents yet");
		const quiet = { ...SNAPSHOT, threads: [] };
		expect(hubStatusLine(hubCounts(quiet), quiet)).toBe("No conversations yet");
		// Separate facts let a narrow screen wrap between them.
		expect(hubStatusParts(counts, SNAPSHOT)).toEqual([
			"1 needs attention",
			"1 working",
			"2 waiting on you",
		]);
	});

	test("failed scheduled runs count toward needs attention", () => {
		const counts = hubWithFailedRuns(
			hubCounts(SNAPSHOT),
			hubFailedRuns(EVENTS, BASE)
		);
		expect(counts.attention).toBe(2);
		expect(hubGlyphCount(hubGlyph(counts), counts)).toBe(2);
		expect(hubStatusLine(counts, SNAPSHOT)).toBe(
			"2 need attention · 1 working · 2 waiting on you"
		);
		// A failed run alone still reads as attention, not "No conversations".
		const runsOnly = { ...SNAPSHOT, threads: [] };
		expect(
			hubStatusLine(
				hubWithFailedRuns(hubCounts(runsOnly), hubFailedRuns(EVENTS, BASE)),
				runsOnly
			)
		).toBe("1 needs attention");
	});

	test("the composer offers idle agents first", () => {
		expect(hubComposeAgents(SNAPSHOT).map((agent) => agent.name)).toEqual([
			"Ada",
			"Linus",
			"Grace",
		]);
	});

	test("the glyph shows the most urgent state and its count", () => {
		const counts = hubCounts(SNAPSHOT);
		expect(hubGlyph(counts)).toBe("attention");
		expect(hubGlyphCount("attention", counts)).toBe(1);
		const calm = hubCounts({
			...SNAPSHOT,
			threads: [thread({ id: "done", updatedAt: ago(5) })],
		});
		expect(hubGlyph(calm)).toBe("your-turn");
		expect(hubGlyph(hubCounts(EMPTY))).toBe("clear");
		expect(hubGlyphCount("clear", hubCounts(EMPTY))).toBe(0);
		expect(hubGlyphLabel("attention", 1)).toBe("1 needs attention");
		expect(hubGlyphLabel("attention", 2)).toBe("2 need attention");
		expect(hubGlyphLabel("your-turn", 3)).toBe("3 waiting on you");
		expect(hubGlyphLabel("clear", 0)).toBe("All caught up");
	});

	test("agent names read as a sentence subject", () => {
		const [ada, grace, linus] = SNAPSHOT.agents;
		if (!(ada && grace && linus)) {
			throw new Error("Expected three agents");
		}
		expect(hubNameList([ada])).toBe("Ada");
		expect(hubNameList([ada, grace])).toBe("Ada and Grace");
		expect(hubNameList([ada, grace, linus])).toBe("Ada, Grace and Linus");
		expect(hubNameList([ada, grace, linus, { ...ada, id: "x" }])).toBe(
			"Ada, Grace and 2 more"
		);
	});

	test("waiting threads put pinned first, then the newest", () => {
		expect(hubThreads(SNAPSHOT, "your-turn").map((item) => item.id)).toEqual([
			"thread-pinned",
			"thread-notes",
		]);
		expect(hubThreads(SNAPSHOT, "working").map((item) => item.id)).toEqual([
			"thread-triage",
		]);
	});

	test("upcoming runs sort by start; failed runs keep only recent failures", () => {
		expect(hubUpcoming(EVENTS, BASE).map((event) => event.id)).toEqual([
			"run-sweep",
			"run-digest",
		]);
		expect(hubUpcoming(undefined, BASE)).toEqual([]);
		expect(hubFailedRuns(EVENTS, BASE).map((event) => event.id)).toEqual([
			"run-old",
		]);
		expect(hubFailedRuns(EVENTS, BASE + 3 * 24 * HOUR)).toEqual([]);
	});

	test("relative times read like a smart display", () => {
		expect(hubRunWhen(ahead(15), BASE, "en-US")).toBe("In 15 min");
		expect(hubRunWhen(ahead(59.8), BASE, "en-US")).toBe("In 1 hr");
		expect(hubRunWhen(ahead(130), BASE, "en-US")).toBe("In 2 hr");
		expect(hubRunWhen(ahead(8 * 60), BASE, "en-US")).toBe("Today, 6:00 PM");
		expect(hubRunWhen(ahead(24 * 60), BASE, "en-US")).toBe(
			"Tomorrow, 10:00 AM"
		);
		expect(hubAgo(ago(0.2), BASE)).toBe("now");
		expect(hubAgo(ago(18), BASE)).toBe("18 min ago");
		expect(hubAgo(ago(180), BASE)).toBe("3 hr ago");
		expect(hubAgo(ago(30 * 60), BASE)).toBe("Yesterday");
	});

	test("dated runs always carry a time, and the headline reads as a sentence", () => {
		const late = new Date(2026, 9, 14, 23, 30, 0).getTime();
		// Within a few hours a countdown wins, even across midnight.
		expect(hubRunWhen(new Date(late + 90 * MINUTE).toISOString(), late)).toBe(
			"In 2 hr"
		);
		expect(hubRunWhen(ahead(9 * 24 * 60), BASE, "en-US")).toBe(
			"Oct 23, 10:00 AM"
		);
		expect(hubNextRunHeadline("In 40 min")).toBe("Next run in 40 min");
		expect(hubNextRunHeadline("Tomorrow, 9:00 AM")).toBe(
			"Next run tomorrow at 9:00\u00a0AM"
		);
		expect(hubNextRunHeadline("Today, 6:00 PM")).toBe(
			"Next run at 6:00\u00a0PM"
		);
		expect(hubNextRunHeadline("Fri, 5:00 PM")).toBe(
			"Next run Fri at 5:00\u00a0PM"
		);
		expect(hubNextRunHeadline("Oct 23, 10:00 AM")).toBe(
			"Next run Oct 23 at 10:00\u00a0AM"
		);
		expect(hubNextRunHeadline("Now")).toBe("A run is starting now");
	});

	test("an agent with a running thread is live, whatever its status says", () => {
		const runs = hubAgentRuns(SNAPSHOT);
		const [ada, grace] = SNAPSHOT.agents;
		if (!(ada && grace)) {
			throw new Error("Expected agents");
		}
		expect(hubAgentLive(grace, runs)).toBe(true);
		expect(hubAgentLive(ada, runs)).toBe(false);
		const started = hubAgentRuns({
			...SNAPSHOT,
			threads: [
				...SNAPSHOT.threads,
				thread({ agentIds: ["agent-ada"], id: "new", running: true }),
			],
		});
		expect(hubAgentLive(ada, started)).toBe(true);
	});

	test("the clock splits the day period off the time", () => {
		expect(hubClock(BASE, "en-US")).toEqual({ dayPeriod: "AM", time: "10:00" });
		expect(hubClock(BASE, "en-GB")).toEqual({ dayPeriod: "", time: "10:00" });
		expect(hubClockDateTime(BASE)).toBe("10:00");
	});

	test("keys map to carousel actions and the row stops at both ends", () => {
		const key = (name: string, mods = {}) =>
			hubKeyAction({
				altKey: false,
				ctrlKey: false,
				key: name,
				metaKey: false,
				...mods,
			});
		expect(key("ArrowRight")).toBe("next");
		expect(key("Escape")).toBe("close");
		expect(key("Enter")).toBe("wake");
		expect(key("ArrowRight", { metaKey: true })).toBe(null);
		expect(stepHubCard(0, -1)).toBe(0);
		expect(stepHubCard(HUB_CARDS.length - 1, 1)).toBe(HUB_CARDS.length - 1);
	});

	test("the ambient art is stable for a day", () => {
		const today = hubArt(hubSeed("2026-10-14"));
		expect(hubArt(hubSeed("2026-10-14"))).toEqual(today);
		expect(hubArt(hubSeed("2026-10-15"))).not.toEqual(today);
		expect(today.ridges).toHaveLength(4);
	});
});

describe("HubInterface", () => {
	// The component reads the wall clock; pin it to the fixture's moment.
	beforeEach(() => setSystemTime(new Date(BASE)));
	afterEach(() => setSystemTime());

	test("rests on the ambient screen with the clock and status line", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(hub(port));
		expect(markup).toContain('data-testid="interface-hub"');
		expect(markup).toContain('data-state="ambient"');
		expect(markup).toMatch(/<time[^>]*data-testid="hub-clock"/);
		expect(markup).toContain('dateTime="10:00"');
		// The glyph and the line agree, counting the failed scheduled run.
		expect(markup).toContain('title="2 need attention"');
		expect(markup).toContain("2 need attention, 1 working, 2 waiting on you");
		expect(markup).toContain('aria-label="Show cards"');
		expect(markup).not.toContain('data-testid="hub-cards"');
	});

	test("renders loading and empty states", () => {
		const { port } = recordingPort();
		const loading = renderToStaticMarkup(
			hub(port, { loading: true, snapshot: EMPTY })
		);
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain("No agents yet");
		const empty = renderToStaticMarkup(hub(port, { snapshot: EMPTY }));
		expect(empty).toContain("No agents yet");
	});

	test("an open thread shows the host view in a sheet over the cards", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			hub(port, {
				activeThreadId: "thread-triage",
				threadView: <div data-testid="host-thread-view">Host</div>,
			})
		);
		expect(markup).toContain('data-state="open"');
		expect(markup).toContain('data-testid="hub-thread-sheet"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain("aria-labelledby=");
		expect(markup).toContain(">Crash triage</h2>");
		expect(markup).toContain('aria-label="Back to cards"');
	});

	test("wakes into cards, opens threads, and sleeps on Escape", async () => {
		// The cards read the wall clock; pin it to the fixture's morning so the
		// fixture's upcoming runs are still ahead whenever the suite runs.
		setSystemTime(new Date(BASE));
		const { calls, port } = recordingPort();
		const view = await mount(hub(port));
		expect(state(view.container)).toBe("ambient");
		await click(button(view.container, "Show cards"));
		expect(state(view.container)).toBe("cards");
		const cards = [
			...view.container.querySelectorAll("section[data-card]"),
		].map((card) => card.getAttribute("data-card"));
		expect(cards).toEqual([...HUB_CARDS]);

		await click(button(view.container, "Open Logo choice"));
		await click(button(view.container, "Open Crash triage, running"));
		await click(button(view.container, "Open Flaky test, failed"));
		expect(calls).toEqual([
			"open:thread-pinned",
			"open:thread-triage",
			"open:thread-flaky",
		]);
		expect(view.container.textContent).toContain("Dependency audit");
		expect(view.container.textContent).toContain("Inbox sweep");

		await press("Escape");
		expect(state(view.container)).toBe("ambient");
		await press("Enter");
		expect(state(view.container)).toBe("cards");
		await view.dispose();
	});

	test("arrow keys and page dots move the current card", async () => {
		const { port } = recordingPort();
		const view = await mount(hub(port));
		await press("Enter");
		const current = () =>
			view.container
				.querySelector('nav[aria-label="Cards"] [aria-current="true"]')
				?.getAttribute("aria-label");
		expect(current()).toBe("Waiting on you");
		await press("ArrowRight");
		await press("ArrowRight");
		expect(current()).toBe("Needs attention");
		await press("End");
		expect(current()).toBe("Start a conversation");
		await press("ArrowRight");
		expect(current()).toBe("Start a conversation");
		await click(button(view.container, "Agents"));
		expect(current()).toBe("Agents");
		await press("Home");
		expect(current()).toBe("Waiting on you");
		await view.dispose();
	});

	test("the composer sends only what the user typed, to the chosen agent", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(hub(port));
		await press("Enter");
		// Before any pick, the composer addresses the first idle agent.
		expect(view.container.querySelector("textarea")?.placeholder).toBe(
			"What should Ada do?"
		);
		await click(button(view.container, "Message Linus, idle"));
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("Expected the composer field");
		}
		expect(field.placeholder).toBe("What should Linus do?");
		const send = [...view.container.querySelectorAll("button")].find(
			(candidate) => candidate.textContent?.trim() === "Send"
		);
		expect(send?.hasAttribute("disabled")).toBe(true);
		await click(send);
		expect(calls).toEqual([]);

		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			field.focus();
			setter?.call(field, "  Review the intro  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			// happy-dom has no native input event support; React reads keyup.
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		await act(async () => {
			field.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
			);
		});
		expect(calls).toEqual([
			'start:{"agentId":"agent-linus","prompt":"Review the intro"}',
		]);
		expect(field.value).toBe("");
		// Arrows in the field stay with the caret.
		await press("ArrowRight", field);
		expect(
			view.container
				.querySelector('nav[aria-label="Cards"] [aria-current="true"]')
				?.getAttribute("aria-label")
		).toBe("Start a conversation");
		await view.dispose();
	});

	test("Escape and the back control close the open thread", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			hub(port, {
				activeThreadId: "thread-notes",
				threadView: <div>Host</div>,
			})
		);
		expect(state(view.container)).toBe("open");
		await click(button(view.container, "Back to cards"));
		await press("Escape");
		expect(calls).toEqual(["close", "close"]);
		await view.rerender(hub(port));
		expect(state(view.container)).toBe("cards");
		await view.dispose();
	});

	test("the sheet takes focus, makes the cards inert, and gives focus back", async () => {
		const { port } = recordingPort();
		const view = await mount(hub(port));
		await press("Enter");
		const row = button(view.container, "Open Logo choice");
		expect(row).toBeInstanceOf(HTMLButtonElement);
		row?.focus();
		await view.rerender(
			hub(port, {
				activeThreadId: "thread-pinned",
				threadView: <div>Host</div>,
			})
		);
		const cards = view.container.querySelector('[data-testid="hub-cards"]');
		expect(cards?.hasAttribute("inert")).toBe(true);
		const sheet = view.container.querySelector(
			'[data-testid="hub-thread-sheet"]'
		);
		expect(sheet?.getAttribute("role")).toBe("dialog");
		expect(sheet?.getAttribute("aria-modal")).toBe("true");
		expect(document.activeElement).toBe(sheet ?? null);
		await view.rerender(hub(port));
		expect(cards?.hasAttribute("inert")).toBe(false);
		expect(document.activeElement).toBe(row ?? null);
		await view.dispose();
	});

	test("a long list shows the first rows and expands in place", async () => {
		const { port } = recordingPort();
		const many = {
			...SNAPSHOT,
			threads: Array.from({ length: 6 }, (_, position) =>
				thread({
					agentIds: ["agent-ada"],
					id: `waiting-${position}`,
					title: `Question ${position}`,
					updatedAt: ago(position + 1),
				})
			),
		};
		const view = await mount(hub(port, { snapshot: many }));
		await press("Enter");
		const waiting = () =>
			view.container.querySelectorAll('section[data-card="waiting"] li').length;
		expect(waiting()).toBe(3);
		await click(
			[...view.container.querySelectorAll("button")].find(
				(candidate) => candidate.textContent === "Show all 6"
			)
		);
		expect(waiting()).toBe(6);
		await view.dispose();
	});
	test("Working now rows carry a live track, and agent counts follow running threads", async () => {
		const { port } = recordingPort();
		const started = {
			...SNAPSHOT,
			threads: [
				thread({
					agentIds: ["agent-ada"],
					id: "thread-new",
					running: true,
					title: "New run",
					updatedAt: ago(1),
				}),
				...SNAPSHOT.threads,
			],
		};
		const view = await mount(hub(port, { snapshot: started }));
		await press("Enter");
		const working = view.container.querySelector(
			'section[data-card="working"]'
		);
		expect(
			working?.querySelectorAll('[data-testid="hub-live-track"]').length
		).toBe(2);
		const agents = view.container.querySelector('section[data-card="agents"]');
		expect(agents?.textContent).toContain("2 of 3 working");
		expect(button(view.container, "Message Ada, working")).toBeDefined();
		await view.dispose();
	});

	test("a run's question carries the run, and a plain message stays as typed", () => {
		expect(hubTopicPrompt("Dependency audit", "Why did it fail?")).toBe(
			'About the run "Dependency audit": Why did it fail?'
		);
		expect(hubTopicPrompt(undefined, "Review the intro")).toBe(
			"Review the intro"
		);
	});

	test("asking about a run sends the run's context with the typed question", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(hub(port));
		await press("Enter");
		await click(
			button(view.container, "Ask Grace about Dependency audit, failed")
		);
		await typeAndSend(view.container, "Why did it fail?");
		expect(calls).toEqual([
			`start:${JSON.stringify({
				agentId: "agent-grace",
				prompt: 'About the run "Dependency audit": Why did it fail?',
			})}`,
		]);
		// The topic is spent: the next message goes out as typed.
		expect(view.container.querySelector("textarea")?.placeholder).toBe(
			"What should Grace do?"
		);
		await view.dispose();
	});

	test("asking about a run with no agent resets the pick to the default recipient", async () => {
		const { calls, port } = recordingPort();
		const agentless: InterfaceSnapshot = {
			...SNAPSHOT,
			events: [
				...EVENTS,
				{
					agentId: null,
					id: "run-orphan",
					kind: "past",
					label: "Nightly",
					outcome: "failure",
					start: ago(240),
					title: "Disk check",
				},
			],
		};
		const view = await mount(hub(port, { snapshot: agentless }));
		await press("Enter");
		await click(button(view.container, "Message Linus, idle"));
		expect(view.container.querySelector("textarea")?.placeholder).toBe(
			"What should Linus do?"
		);
		await click(
			button(view.container, "Ask an agent about Disk check, failed")
		);
		expect(view.container.querySelector("textarea")?.placeholder).toBe(
			"Ask Ada about Disk check"
		);
		await typeAndSend(view.container, "Is the disk full?");
		expect(calls).toEqual([
			`start:${JSON.stringify({
				agentId: "agent-ada",
				prompt: 'About the run "Disk check": Is the disk full?',
			})}`,
		]);
		await view.dispose();
	});

	test("a failed scheduled run asks its agent through the composer, sending nothing", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(hub(port));
		await press("Enter");
		await click(
			button(view.container, "Ask Grace about Dependency audit, failed")
		);
		expect(calls).toEqual([]);
		expect(
			view.container
				.querySelector('nav[aria-label="Cards"] [aria-current="true"]')
				?.getAttribute("aria-label")
		).toBe("Start a conversation");
		expect(view.container.querySelector("textarea")?.placeholder).toBe(
			"Ask Grace about Dependency audit"
		);
		await view.dispose();
	});

	test("the open sheet is named by its visible title", async () => {
		const { port } = recordingPort();
		const view = await mount(
			hub(port, {
				activeThreadId: "thread-notes",
				threadView: <div>Host</div>,
			})
		);
		const sheet = view.container.querySelector(
			'[data-testid="hub-thread-sheet"]'
		);
		const titleId = sheet?.getAttribute("aria-labelledby") ?? "";
		expect(sheet?.hasAttribute("aria-label")).toBe(false);
		expect(document.getElementById(titleId)?.textContent).toBe("Release notes");
		await view.dispose();
	});
});
