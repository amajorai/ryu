import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
	type InterfacePort,
	type InterfaceSnapshot,
	type InterfaceThread,
	layoutWorld,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { spokenLine, World3dDialog } from "./world-3d-dialog.tsx";
import { trackerLabel } from "./world-3d-hud.tsx";
import { showPlate, World3dInterface } from "./world-3d-interface.tsx";
import {
	agentUrgencies,
	shortStatusLabel,
	threadSpeaker,
	trackerGoal,
} from "./world-3d-model.ts";

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
			agentIds: ["agent-grace"],
			id: "thread-flaky",
			lastMessage: "The run stopped.",
			runState: "failed",
			title: "Flaky test",
			updatedAt: ago(120),
		}),
	],
	version: 1,
};

const ADA = SNAPSHOT.agents[0];
const GRACE = SNAPSHOT.agents[1];
const LINUS = SNAPSHOT.agents[2];

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
		async render(next: ReactElement) {
			await act(async () => root.render(next));
		},
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
	return [...container.querySelectorAll("button")].find((candidate) =>
		(candidate.getAttribute("aria-label") ?? candidate.textContent ?? "")
			.trim()
			.startsWith(name)
	);
}

async function pressEnter(target: HTMLElement) {
	await act(async () => {
		target.dispatchEvent(
			new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })
		);
	});
}

async function typeInto(field: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		HTMLTextAreaElement.prototype,
		"value"
	)?.set;
	await act(async () => {
		field.focus();
		setter?.call(field, value);
		field.dispatchEvent(new Event("input", { bubbles: true }));
		// React falls back to keyup when it loaded before the DOM was registered.
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

function threadsOf(agentId: string) {
	return SNAPSHOT.threads
		.filter((item) => item.agentIds.includes(agentId))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

describe("world 3d model", () => {
	test("each agent's most urgent conversation wins over its newest", () => {
		const urgencies = agentUrgencies(SNAPSHOT.threads);
		expect(urgencies.get("agent-grace")?.status).toBe("attention");
		expect(urgencies.get("agent-grace")?.thread.id).toBe("thread-flaky");
		expect(urgencies.get("agent-ada")?.status).toBe("your-turn");
		expect(urgencies.has("agent-linus")).toBe(false);
	});

	test("the tracker routes to a failed run before a reply", () => {
		const { entities } = layoutWorld(SNAPSHOT);
		const goal = trackerGoal({
			entities,
			loading: false,
			player: { x: 0, y: 0 },
			threads: SNAPSHOT.threads,
		});
		expect(goal).toEqual({
			agentId: "agent-grace",
			agentName: "Grace",
			detail: "Run failed · Flaky test",
			status: "attention",
			title: "Grace needs you",
		});
		const calm = trackerGoal({
			entities,
			loading: false,
			player: { x: 0, y: 0 },
			threads: SNAPSHOT.threads.filter((item) => item.id !== "thread-flaky"),
		});
		expect(calm.title).toBe("Ada replied");
		expect(calm.status).toBe("your-turn");
	});

	test("an interrupted run reads as interrupted, not failed", () => {
		const { entities } = layoutWorld(SNAPSHOT);
		const threads = SNAPSHOT.threads.map((item) =>
			item.id === "thread-flaky"
				? { ...item, runState: "interrupted" as const }
				: item
		);
		const goal = trackerGoal({
			entities,
			loading: false,
			player: { x: 0, y: 0 },
			threads,
		});
		expect(goal.detail).toBe("Run interrupted · Flaky test");
		expect(goal.status).toBe("attention");
		const interrupted = threads.find((item) => item.id === "thread-flaky");
		const failed = SNAPSHOT.threads.find((item) => item.id === "thread-flaky");
		if (!(interrupted && failed)) {
			throw new Error("fixture thread missing");
		}
		expect(shortStatusLabel(interrupted)).toBe("Interrupted");
		expect(shortStatusLabel(failed)).toBe("Failed");
	});

	test("the tracker falls back to the nearest agent, loading and empty copy", () => {
		const { entities } = layoutWorld(SNAPSHOT);
		const [first] = entities;
		const quiet = trackerGoal({
			entities,
			loading: false,
			player: { x: first?.x ?? 0, y: (first?.y ?? 0) + 1 },
			threads: [],
		});
		expect(quiet.title).toBe(`Talk to ${first?.name}`);
		expect(quiet.detail).toBe("3 agents · 1 working");
		expect(quiet.status).toBe(null);
		expect(
			trackerGoal({
				entities,
				loading: true,
				player: { x: 0, y: 0 },
				threads: [],
			}).title
		).toBe("Loading agents");
		expect(
			trackerGoal({
				entities: [],
				loading: false,
				player: { x: 0, y: 0 },
				threads: [],
			}).title
		).toBe("No agents yet");
	});

	test("the tracker names where it leads", () => {
		const { entities } = layoutWorld(SNAPSHOT);
		const goal = trackerGoal({
			entities,
			loading: false,
			player: { x: 0, y: 0 },
			threads: SNAPSHOT.threads,
		});
		expect(trackerLabel(goal)).toBe("Go to Grace: Run failed, Flaky test");
		const loadingGoal = trackerGoal({
			entities,
			loading: true,
			player: { x: 0, y: 0 },
			threads: [],
		});
		expect(loadingGoal.agentId).toBe(null);
		expect(trackerLabel(loadingGoal)).toBe("Loading agents");
	});

	test("a hidden name plate leaves the Tab order until it shows again", () => {
		const plate = document.createElement("button");
		showPlate(plate, false);
		expect(plate.style.opacity).toBe("0");
		expect(plate.style.pointerEvents).toBe("none");
		expect(plate.tabIndex).toBe(-1);
		showPlate(plate, true);
		expect(plate.style.opacity).toBe("1");
		expect(plate.style.pointerEvents).toBe("");
		expect(plate.tabIndex).toBe(0);
	});

	test("a shared thread is had with the agent already being talked to", () => {
		const shared = ["agent-ada", "agent-grace", "agent-linus"];
		expect(threadSpeaker(shared, "agent-grace")).toBe("agent-grace");
		expect(threadSpeaker(shared, null)).toBe("agent-ada");
		expect(threadSpeaker(shared, "agent-other")).toBe("agent-ada");
		expect(threadSpeaker([], null)).toBe(null);
	});

	test("spoken lines are plain dialogue", () => {
		if (!(ADA && GRACE && LINUS)) {
			throw new Error("fixture agents missing");
		}
		expect(spokenLine(ADA, threadsOf("agent-ada"))).toBe(
			"Draft is ready for review."
		);
		expect(spokenLine(GRACE, threadsOf("agent-grace"))).toBe(
			"Working on “Crash triage”."
		);
		expect(spokenLine(LINUS, [])).toBe("What should we work on?");
		expect(spokenLine({ ...LINUS, status: "working" }, [])).toBe(
			"Working on something right now."
		);
		expect(
			spokenLine(LINUS, [
				thread({ id: "draft", lastMessageRole: "user", title: "Plan" }),
			])
		).toBe("Pick up “Plan”?");
	});
});

describe("World3dInterface", () => {
	test("renders the root, the tracker and the loading and empty states", () => {
		const { port } = recordingPort();
		const markup = renderToStaticMarkup(
			<World3dInterface
				activeThreadId={null}
				loading={false}
				params={{ camera: "orbit", theme: "meadow" }}
				port={port}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		expect(markup).toContain('data-testid="interface-world-3d"');
		expect(markup).toContain('data-testid="world-3d-tracker"');
		expect(markup).toContain("Grace needs you");
		expect(markup).toContain("Loading world");

		const loading = renderToStaticMarkup(
			<World3dInterface
				activeThreadId={null}
				loading
				params={{ camera: "orbit", theme: "meadow" }}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(loading).toContain("Loading agents");
		expect(loading).not.toContain("world-3d-empty");

		const empty = renderToStaticMarkup(
			<World3dInterface
				activeThreadId={null}
				loading={false}
				params={{ camera: "orbit", theme: "meadow" }}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(empty).toContain('data-testid="world-3d-empty"');
		expect(empty).toContain("No agents in the");
		expect(empty).not.toContain("world-3d-tracker");
	});

	test("the empty state starts a conversation only when clicked", async () => {
		const { calls, port } = recordingPort();
		const view = await mount(
			<World3dInterface
				activeThreadId={null}
				loading={false}
				params={{ camera: "orbit", theme: "meadow" }}
				port={port}
				snapshot={{ ...SNAPSHOT, agents: [], threads: [] }}
				threadView={null}
			/>
		);
		expect(calls).toEqual([]);
		await click(buttonNamed(view.container, "New conversation"));
		expect(calls).toEqual(["start:{}"]);
		await view.dispose();
	});
});

describe("World3dInterface conversations", () => {
	test("opening a shared thread from a dialogue keeps the speaker", async () => {
		const { calls, port } = recordingPort();
		const snapshot: InterfaceSnapshot = {
			...SNAPSHOT,
			threads: [
				...SNAPSHOT.threads,
				thread({
					agentIds: ["agent-ada", "agent-grace"],
					id: "thread-pair",
					lastMessage: "Both of us are on it.",
					title: "Pairing session",
					updatedAt: ago(200),
				}),
			],
		};
		const props = {
			loading: false,
			params: { camera: "orbit", theme: "meadow" },
			port,
			snapshot,
		} as const;
		const view = await mount(
			<World3dInterface {...props} activeThreadId={null} threadView={null} />
		);
		// The tracker walks to Grace (a failed run), who is not the thread's first agent.
		await click(
			view.container.querySelector('[data-testid="world-3d-tracker"]')
		);
		expect(
			view.container.querySelector("aside")?.getAttribute("aria-label")
		).toBe("Talking to Grace");
		await click(buttonNamed(view.container, "Pairing session"));
		expect(calls).toContain("open:thread-pair");
		await view.render(
			<World3dInterface
				{...props}
				activeThreadId="thread-pair"
				threadView={<div data-testid="host-thread">Host chat</div>}
			/>
		);
		expect(
			view.container.querySelector("aside")?.getAttribute("aria-label")
		).toBe("Talking to Grace");
		const panel = view.container.querySelector(
			'[data-testid="world-3d-thread-panel"]'
		);
		expect(panel?.querySelector("h2")?.textContent).toBe("Pairing session");
		expect(panel?.querySelector("header p")?.textContent).toContain("Grace");
		await view.dispose();
	});
});

describe("World3dDialog", () => {
	test("offers a new conversation, past conversations with status, and leaving", async () => {
		if (!GRACE) {
			throw new Error("fixture agent missing");
		}
		const { calls, port } = recordingPort();
		let closed = 0;
		const view = await mount(
			<World3dDialog
				agent={GRACE}
				onClose={() => {
					closed += 1;
				}}
				port={port}
				threads={threadsOf("agent-grace")}
				threadView={null}
			/>
		);
		const region = view.container.querySelector("aside");
		expect(region?.getAttribute("aria-label")).toBe("Talking to Grace");
		const choices = view.container.querySelector(
			'nav[aria-label="Dialogue options"]'
		);
		expect(choices?.textContent).toContain("New conversation");
		expect(choices?.textContent).toContain("Past conversations");
		const triage = buttonNamed(view.container, "Crash triage");
		const flaky = buttonNamed(view.container, "Flaky test");
		expect(triage?.textContent).toContain("Working");
		expect(flaky?.textContent).toContain("Failed");
		expect(view.container.textContent).toContain("Working on");

		await click(flaky);
		expect(calls).toEqual(["open:thread-flaky"]);
		await click(buttonNamed(view.container, "Walk away"));
		expect(closed).toBe(1);
		await view.dispose();
	});

	test("an agent whose most urgent run was interrupted reads Interrupted, like its row", async () => {
		if (!GRACE) {
			throw new Error("fixture agent missing");
		}
		const { port } = recordingPort();
		const threads = threadsOf("agent-grace")
			.filter((item) => item.id === "thread-flaky")
			.map((item) => ({ ...item, runState: "interrupted" as const }));
		const view = await mount(
			<World3dDialog
				agent={{ ...GRACE, status: "idle" }}
				onClose={() => undefined}
				port={port}
				threads={threads}
				threadView={null}
			/>
		);
		const statusLine = [...view.container.querySelectorAll("p")].find((node) =>
			node.textContent?.includes(GRACE.description ?? "")
		);
		expect(statusLine?.textContent).toContain("Interrupted");
		expect(statusLine?.textContent).not.toContain("Failed");
		expect(buttonNamed(view.container, "Flaky test")?.textContent).toContain(
			"Interrupted"
		);
		await view.dispose();
	});

	test("labels a reply and a message waiting on the agent", async () => {
		if (!ADA) {
			throw new Error("fixture agent missing");
		}
		const { port } = recordingPort();
		const view = await mount(
			<World3dDialog
				agent={ADA}
				onClose={() => undefined}
				port={port}
				threads={threadsOf("agent-ada")}
				threadView={null}
			/>
		);
		expect(buttonNamed(view.container, "Release notes")?.textContent).toContain(
			"Your turn"
		);
		expect(buttonNamed(view.container, "Intro edits")?.textContent).toContain(
			"Waiting"
		);
		await view.dispose();
	});

	test("the composer sends only the submitted, trimmed prompt", async () => {
		if (!LINUS) {
			throw new Error("fixture agent missing");
		}
		const { calls, port } = recordingPort();
		const view = await mount(
			<World3dDialog
				agent={LINUS}
				onClose={() => undefined}
				port={port}
				threads={[]}
				threadView={null}
			/>
		);
		await click(buttonNamed(view.container, "New conversation"));
		const field = view.container.querySelector("textarea");
		if (!(field instanceof HTMLTextAreaElement)) {
			throw new Error("Expected the composer");
		}
		const form = field.closest("form");
		const send = form?.querySelector('button[type="submit"]');
		expect(send?.hasAttribute("disabled")).toBe(true);
		await typeInto(field, "   ");
		await pressEnter(field);
		expect(calls).toEqual([]);
		await typeInto(field, "  Plan the launch  ");
		expect(calls).toEqual([]);
		expect(send?.hasAttribute("disabled")).toBe(false);
		await pressEnter(field);
		expect(calls).toEqual([
			`start:${JSON.stringify({ agentId: "agent-linus", prompt: "Plan the launch" })}`,
		]);
		await view.dispose();
	});

	test("shows the host's thread view inside the panel", async () => {
		if (!GRACE) {
			throw new Error("fixture agent missing");
		}
		const { calls, port } = recordingPort();
		const view = await mount(
			<World3dDialog
				agent={GRACE}
				onClose={() => undefined}
				port={port}
				threads={threadsOf("agent-grace")}
				threadView={<div data-testid="host-thread">Host chat</div>}
			/>
		);
		const panel = view.container.querySelector(
			'[data-testid="world-3d-thread-panel"]'
		);
		expect(panel?.querySelector('[data-testid="host-thread"]')).not.toBe(null);
		expect(view.container.querySelector("textarea")).toBe(null);
		await click(buttonNamed(view.container, "Back to conversations"));
		expect(calls).toEqual(["close"]);
		await view.dispose();
	});
});

describe("world-3d settings", () => {
	const world = (params: Parameters<typeof World3dInterface>[0]["params"]) => (
		<World3dInterface
			activeThreadId={null}
			loading={false}
			params={params}
			port={recordingPort().port}
			snapshot={SNAPSHOT}
			threadView={null}
		/>
	);
	const MINIMAP = "ryu-w3d-minimap-clip";

	test("the minimap shows by default and hides when turned off", () => {
		expect(
			renderToStaticMarkup(world({ camera: "orbit", theme: "meadow" }))
		).toContain(MINIMAP);
		expect(
			renderToStaticMarkup(
				world({ camera: "orbit", minimap: false, theme: "meadow" })
			)
		).not.toContain(MINIMAP);
	});

	test("turning the minimap on applies live", async () => {
		const view = await mount(
			world({ camera: "orbit", minimap: false, theme: "meadow" })
		);
		expect(view.container.innerHTML).not.toContain(MINIMAP);
		await view.render(
			world({ camera: "orbit", minimap: true, theme: "meadow" })
		);
		expect(view.container.innerHTML).toContain(MINIMAP);
		await view.dispose();
	});
});
