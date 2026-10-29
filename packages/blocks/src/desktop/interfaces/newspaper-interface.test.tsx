import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceEvent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { NewspaperInterface } from "./newspaper-interface.tsx";
import {
	buildEdition,
	eventDay,
	eventSchedule,
	glanceCounts,
	joinNames,
	storyAge,
	storyByline,
	storyKicker,
	upcomingEvents,
} from "./newspaper-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.now();
const ago = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString();
const ahead = (hours: number) => new Date(NOW + hours * HOUR).toISOString();

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
		agentId: "agent-grace",
		id: "event-past",
		kind: "past",
		label: "Daily at 6 AM",
		outcome: "success",
		start: ago(180),
		title: "Backup check",
	},
	{
		agentId: "agent-ada",
		id: "event-later",
		kind: "upcoming",
		label: "Weekdays at 9 AM",
		start: ahead(30),
		title: "Standup summary",
	},
	{
		agentId: "agent-grace",
		count: 24,
		id: "event-soon",
		kind: "upcoming",
		label: "Every hour",
		start: ahead(1),
		title: "Inbox sweep",
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
	],
	events: EVENTS,
	groups: [
		{
			id: "project-site",
			kind: "project",
			memberAgentIds: ["agent-ada"],
			name: "Website",
		},
		{
			id: "team-docs",
			kind: "team",
			memberAgentIds: ["agent-ada", "agent-grace"],
			name: "Docs Crew",
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
			id: "thread-pinned",
			lastMessage: "Pinned reply.",
			pinned: true,
			projectId: "project-site",
			title: "Pinned plan",
			updatedAt: ago(300),
		}),
		thread({
			agentIds: ["agent-grace"],
			id: "thread-triage",
			lastMessage: "Looking at the crash reports now.",
			running: true,
			teamId: "team-docs",
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
		thread({
			agentIds: ["agent-ada", "agent-grace"],
			id: "thread-joint",
			lastMessage: "Both of us signed off.",
			projectId: "project-site",
			title: "Joint review",
			updatedAt: ago(700),
		}),
		thread({
			id: "thread-blank",
			lastMessageRole: null,
			messageCount: 0,
			title: "Blank page",
			updatedAt: ago(900),
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

function buttonNamed(container: HTMLElement, name: string) {
	return [...container.querySelectorAll("button")].find(
		(candidate) =>
			candidate.getAttribute("aria-label") === name ||
			candidate.textContent?.trim() === name
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
	props: Partial<Parameters<typeof NewspaperInterface>[0]> = {}
): string {
	const { port } = recordingPort();
	return renderToStaticMarkup(
		<NewspaperInterface
			activeThreadId={null}
			loading={false}
			params={{}}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
			{...props}
		/>
	);
}

describe("newspaper model", () => {
	test("leads with the failed run, then live work, pinned replies, and the rest", () => {
		const edition = buildEdition(SNAPSHOT);
		expect(edition.lead?.thread.id).toBe("thread-flaky");
		expect(edition.secondary.map((story) => story.thread.id)).toEqual([
			"thread-triage",
			"thread-pinned",
			"thread-notes",
		]);
		expect(edition.package.map((story) => story.thread.id)).toEqual([
			"thread-joint",
			"thread-loose",
		]);
		expect(edition.briefs.map((story) => story.thread.id)).toEqual([
			"thread-blank",
		]);
	});

	test("section fronts index every story filed to a project or team", () => {
		const { sections } = buildEdition(SNAPSHOT);
		expect(sections.map((section) => section.group.name)).toEqual([
			"Website",
			"Docs Crew",
		]);
		expect(sections[0]?.stories.map((story) => story.thread.id)).toEqual([
			"thread-pinned",
			"thread-joint",
		]);
		expect(sections[1]?.members.map((agent) => agent.name)).toEqual([
			"Ada",
			"Grace",
		]);
		const empty = buildEdition({ ...SNAPSHOT, threads: [] });
		expect(empty.lead).toBeUndefined();
		expect(empty.sections).toEqual([]);
	});

	test("kickers and bylines read like print", () => {
		const stories = buildEdition(SNAPSHOT).stories;
		const byId = (id: string) => {
			const story = stories.find((item) => item.thread.id === id);
			if (!story) {
				throw new Error(`missing ${id}`);
			}
			return story;
		};
		expect(storyKicker(byId("thread-flaky"))).toBe("Run failed");
		expect(storyKicker(byId("thread-triage"))).toBe("Live");
		expect(storyKicker(byId("thread-notes"))).toBe("Your turn");
		expect(storyKicker(byId("thread-loose"))).toBe("Waiting on an agent");
		expect(storyKicker(byId("thread-blank"))).toBe("Not started");
		expect(
			storyKicker({
				...byId("thread-flaky"),
				thread: { ...byId("thread-flaky").thread, runState: "interrupted" },
			})
		).toBe("Run interrupted");
		expect(storyByline(byId("thread-joint"))).toBe("By Ada and Grace");
		expect(storyByline(byId("thread-loose"))).toBe("Filed by you");
		expect(storyByline(byId("thread-blank"))).toBe("No agent assigned");
		expect(joinNames(["Atlas", "Echo", "Forge"])).toBe("Atlas, Echo and Forge");
	});

	test("counts the paper by status", () => {
		expect(glanceCounts(buildEdition(SNAPSHOT).stories)).toEqual({
			attention: 1,
			quiet: 1,
			waiting: 1,
			working: 1,
			"your-turn": 3,
		});
	});

	test("ages and schedules are set in newsroom style", () => {
		const noon = new Date(2026, 9, 13, 12, 0).getTime();
		const at = (hours: number, minutes = 0) =>
			new Date(noon - hours * HOUR - minutes * MINUTE).toISOString();
		expect(storyAge(at(0, 0), noon)).toBe("Just now");
		expect(storyAge(at(0, 12), noon)).toBe("12 min ago");
		expect(storyAge(at(3), noon)).toBe("3 hr ago");
		expect(storyAge(at(20), noon)).toBe("Yesterday");
		expect(storyAge(at(24 * 3), noon)).toBe("3 days ago");
		expect(storyAge("not a date", noon)).toBe("");
		expect(eventDay(new Date(noon + 2 * HOUR).toISOString(), noon)).toBe(
			"Today"
		);
		expect(eventDay(new Date(noon + 24 * HOUR).toISOString(), noon)).toBe(
			"Tomorrow"
		);
		expect(eventSchedule(EVENTS[2] as InterfaceEvent)).toBe(
			"Every hour · 24 runs"
		);
	});

	test("upcoming lists only future runs, soonest first", () => {
		expect(upcomingEvents(EVENTS, NOW).map((event) => event.id)).toEqual([
			"event-soon",
			"event-later",
		]);
		expect(upcomingEvents(undefined, NOW)).toEqual([]);
	});
});

describe("NewspaperInterface", () => {
	test("sets the front page: masthead, lead, briefs, sections, and sidebar", () => {
		const markup = render();
		expect(markup).toContain('data-testid="interface-newspaper"');
		expect(markup).toContain("The Daily Brief");
		expect(markup).toContain("Today’s paper");
		expect(markup).toContain('data-slot="lead"');
		expect(markup).toContain("Flaky test");
		expect(markup).toContain("By Grace");
		expect(markup).toContain("At a glance");
		expect(markup).toContain("Upcoming");
		expect(markup).toContain("Inbox sweep");
		expect(markup).toContain("In brief");
		expect(markup).toContain("Docs Crew");
		expect(markup).toContain("Submit a story");
	});

	test("omits Upcoming when the host has no schedules", () => {
		const markup = render({ snapshot: { ...SNAPSHOT, events: undefined } });
		expect(markup).not.toContain("Inbox sweep");
		expect(markup).not.toContain(">Upcoming<");
	});

	test("renders loading and empty editions", () => {
		const loading = render({ loading: true });
		expect(loading).toContain('aria-busy="true"');
		expect(loading).not.toContain('data-slot="lead"');
		const empty = render({ snapshot: { ...SNAPSHOT, threads: [] } });
		expect(empty).toContain('data-state="empty"');
		expect(empty).toContain("No stories have been filed yet");
		expect(empty).toContain("Story assignment");
		const bare = render({ snapshot: { ...SNAPSHOT, agents: [], threads: [] } });
		expect(bare).toContain("Add an agent to the workspace");
		expect(bare).not.toContain("Story assignment");
	});

	test("an open story is an article page around the host's thread view", () => {
		const markup = render({
			activeThreadId: "thread-triage",
			threadView: <div data-testid="host-thread-view">Host</div>,
		});
		expect(markup).toContain('data-state="open"');
		expect(markup).toContain('data-testid="newspaper-article"');
		expect(markup).toContain('data-testid="host-thread-view"');
		expect(markup).toContain("Crash triage");
		expect(markup).toContain("By Grace");
		expect(markup).toContain("Front page");
		expect(markup).toContain("More in today’s paper");
		const fresh = render({
			activeThreadId: null,
			threadView: <div>Host</div>,
		});
		expect(fresh).toContain("New story");
	});

	test("headlines, sections, staff, and the composer act through the port", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<NewspaperInterface
				activeThreadId={null}
				loading={false}
				params={{}}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		await click(buttonNamed(view.container, "Flaky test"));
		await click(buttonNamed(view.container, "New story in Website"));
		await click(buttonNamed(view.container, "New story in Docs Crew"));
		await click(buttonNamed(view.container, "New story with Ada"));

		const field = view.container.querySelector("textarea");
		const fileButton = buttonNamed(view.container, "File story");
		expect(fileButton?.hasAttribute("disabled")).toBe(true);
		await act(async () => {
			if (!field) {
				return;
			}
			const setter = Object.getOwnPropertyDescriptor(
				HTMLTextAreaElement.prototype,
				"value"
			)?.set;
			field.focus();
			setter?.call(field, "  Check the build  ");
			field.dispatchEvent(new Event("input", { bubbles: true }));
			// React picks its change events when it loads; under happy-dom that
			// can be the keyup fallback, so send both.
			field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
		});
		expect(
			buttonNamed(view.container, "File story")?.hasAttribute("disabled")
		).toBe(false);
		await act(async () => {
			field?.dispatchEvent(
				new KeyboardEvent("keydown", {
					bubbles: true,
					cancelable: true,
					key: "Enter",
				})
			);
		});
		expect(calls).toEqual([
			"open:thread-flaky",
			'start:{"projectId":"project-site"}',
			'start:{"teamId":"team-docs"}',
			'start:{"agentId":"agent-ada"}',
			'start:{"agentId":"agent-ada","prompt":"Check the build"}',
		]);
		expect(field?.value).toBe("");
		await view.dispose();
	});

	test("focus moves to the article, Escape returns to the headline", async () => {
		const calls: string[] = [];
		function Host() {
			const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
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
				<NewspaperInterface
					activeThreadId={activeThreadId}
					loading={false}
					params={{}}
					port={port}
					snapshot={SNAPSHOT}
					threadView={activeThreadId ? <div>Host</div> : null}
				/>
			);
		}
		const view = await mount(<Host />);
		await click(buttonNamed(view.container, "Crash triage"));
		expect(calls).toEqual(["open:thread-triage"]);
		expect(document.activeElement?.tagName).toBe("H1");
		expect(document.activeElement?.textContent).toBe("Crash triage");

		await act(async () => {
			document.activeElement?.dispatchEvent(
				new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })
			);
		});
		expect(calls).toEqual(["open:thread-triage", "close"]);
		expect(document.activeElement?.textContent).toBe("Crash triage");
		expect(document.activeElement?.tagName).toBe("BUTTON");
		await view.dispose();
	});
});
