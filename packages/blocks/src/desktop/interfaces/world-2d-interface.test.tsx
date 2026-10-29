import { afterAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type {
	InterfaceAgent,
	InterfacePort,
	InterfaceSnapshot,
	InterfaceThread,
	WorldLayout,
} from "@ryuhq/protocol/interfaces";
import { act, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPixelFont } from "./world-2d-font.ts";
import { PIXEL_GLYPHS } from "./world-2d-font-glyphs.ts";
import { World2dInterface } from "./world-2d-interface.tsx";
import {
	countNeedingYou,
	HINT_NARROW_WIDTH,
	hintOpensByDefault,
	TALK_SIDE_OFFSET,
	talkSpot,
	villagerStatuses,
	villagerStatusSuffix,
} from "./world-2d-model.ts";

const NOW = Date.now();

function agent(
	id: string,
	name: string,
	status: InterfaceAgent["status"] = "idle"
): InterfaceAgent {
	return { avatarUrl: null, description: "", id, name, status };
}

function thread(
	id: string,
	agentId: string,
	overrides: Partial<InterfaceThread> = {}
): InterfaceThread {
	return {
		agentIds: [agentId],
		id,
		lastMessage: "",
		lastMessageRole: null,
		messageCount: 1,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: id,
		updatedAt: new Date(NOW).toISOString(),
		...overrides,
	};
}

const AGENTS = [
	agent("agent-cipher", "Cipher"),
	agent("agent-delta", "Delta", "working"),
	agent("agent-echo", "Echo"),
	agent("agent-forge", "Forge"),
];

const THREADS = [
	thread("thread-audit", "agent-cipher", {
		lastMessageRole: "assistant",
		runState: "failed",
		title: "Audit lockfile advisories",
	}),
	thread("thread-deploy", "agent-delta", {
		lastMessageRole: "user",
		running: true,
		title: "Roll out gateway",
	}),
	thread("thread-notes", "agent-echo", {
		lastMessageRole: "assistant",
		title: "Release notes",
	}),
];

const SNAPSHOT: InterfaceSnapshot = {
	agents: AGENTS,
	groups: [],
	threads: THREADS,
	version: 1,
};

const EMPTY_SNAPSHOT: InterfaceSnapshot = {
	agents: [],
	groups: [],
	threads: [],
	version: 1,
};

function recordingPort(calls: string[]): InterfacePort {
	return {
		closeThread: () => calls.push("close"),
		openThread: (threadId) => calls.push(`open:${threadId}`),
		startThread: (request) => calls.push(`start:${JSON.stringify(request)}`),
	};
}

const NOOP_PORT = recordingPort([]);

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
	await act(async () => {
		root.render(element);
	});
	return {
		container,
		dispose: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

function byLabel(container: HTMLElement, label: string): HTMLElement {
	const match = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
	if (!match) {
		throw new Error(`Nothing labeled ${label}`);
	}
	return match;
}

async function click(element: HTMLElement) {
	await act(async () => {
		element.click();
	});
}

function render(snapshot: InterfaceSnapshot, loading = false): string {
	return renderToStaticMarkup(
		<World2dInterface
			activeThreadId={null}
			loading={loading}
			params={{ theme: "meadow" }}
			port={NOOP_PORT}
			snapshot={snapshot}
			threadView={null}
		/>
	);
}

describe("world 2d villager status", () => {
	test("ranks each villager by their most urgent thread", () => {
		const statuses = villagerStatuses(AGENTS, THREADS);
		expect(statuses.get("agent-cipher")).toBe("attention");
		expect(statuses.get("agent-delta")).toBe("working");
		expect(statuses.get("agent-echo")).toBe("your-turn");
		expect(statuses.get("agent-forge")).toBe("idle");
		expect(countNeedingYou(statuses)).toBe(2);
	});

	test("a failed run keeps its villager flagged after newer threads", () => {
		const statuses = villagerStatuses(AGENTS, [
			...THREADS,
			thread("thread-later", "agent-cipher", {
				lastMessageRole: "user",
				updatedAt: new Date(NOW + 60_000).toISOString(),
			}),
		]);
		expect(statuses.get("agent-cipher")).toBe("attention");
	});

	test("names the status in hotbar and actor accessible names", async () => {
		expect(villagerStatusSuffix("attention")).toBe(" (needs attention)");
		expect(villagerStatusSuffix("idle")).toBe("");
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			const slots = [
				...container.querySelectorAll('nav[aria-label="Villagers"] li button'),
			].map((slot) => slot.getAttribute("aria-label"));
			expect(slots).toEqual([
				"Visit Cipher (needs attention)",
				"Visit Delta (working)",
				"Visit Echo (your turn)",
				"Visit Forge",
			]);
			expect(container.textContent).toContain("2 need you");
		} finally {
			await dispose();
		}
	});

	test("the talk panel reads the villager's status, not idle", async () => {
		const calls: string[] = [];
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={recordingPort(calls)}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			await click(byLabel(container, "Visit Cipher (needs attention)"));
			const panel = byLabel(container, "Talking to Cipher");
			expect(panel.textContent).toContain("Needs attention");
			expect(panel.textContent).toContain("Audit lockfile advisories");
			expect(panel.textContent).not.toContain("Idle");
			// Nothing was open, so visiting closes nothing on the host.
			expect(calls).toEqual([]);
		} finally {
			await dispose();
		}
	});
});

describe("world 2d village map", () => {
	test("is titled, closes with its X, and visits from a cottage", async () => {
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={NOOP_PORT}
				snapshot={SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			await click(byLabel(container, "Village map"));
			const map = container.querySelector("figure")?.parentElement;
			expect(map?.querySelector("h2")?.textContent).toBe("Ryu Village");
			expect(byLabel(container, "Close map").getAttribute("title")).toBe(
				"Close map (Esc)"
			);
			const cottages = [...(map?.querySelectorAll("figure button") ?? [])].map(
				(cottage) => cottage.getAttribute("aria-label")
			);
			expect(cottages).toContain("Visit Delta (working)");
			await click(byLabel(container, "Close map"));
			expect(container.querySelector('[aria-label="Close map"]')).toBeNull();

			await click(byLabel(container, "Village map"));
			const echo = container.querySelector<HTMLElement>(
				'figure button[aria-label="Visit Echo (your turn)"]'
			);
			if (!echo) {
				throw new Error("No cottage for Echo");
			}
			await click(echo);
			expect(container.querySelector('[aria-label="Close map"]')).toBeNull();
			expect(byLabel(container, "Talking to Echo")).toBeTruthy();
		} finally {
			await dispose();
		}
	});
});

describe("world 2d open thread", () => {
	test("the dialogue box speaks to the open thread, not the villager", async () => {
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId="thread-research"
				loading={false}
				params={{ theme: "meadow" }}
				port={NOOP_PORT}
				snapshot={{
					...SNAPSHOT,
					threads: [
						...THREADS,
						thread("thread-research", "agent-echo", {
							lastMessageRole: "user",
							title: "Survey decoding papers",
							updatedAt: new Date(NOW - 60_000).toISOString(),
						}),
					],
				}}
				threadView={<p>Host chat</p>}
			/>
		);
		try {
			const box = byLabel(container, "Echo says");
			// Echo's newest thread is their turn; the open one is waiting.
			expect(box.textContent).toContain(
				"Picking up where we left off on “Survey decoding papers”."
			);
			expect(box.textContent).toContain("Waiting on agent");
			expect(box.textContent).not.toContain("Release notes");
			expect(box.textContent).not.toContain("Your turn");
			expect(
				container.querySelector('[data-testid="world-2d-thread"]')?.textContent
			).toBe("Host chat");
		} finally {
			await dispose();
		}
	});
});

describe("world 2d talk spot", () => {
	const layout: WorldLayout = {
		entities: [
			{
				agentId: "agent-echo",
				name: "Echo",
				status: "idle",
				threadCount: 1,
				x: 4,
				y: 3,
			},
		],
		height: 10,
		spawn: { x: 4, y: 8 },
		width: 10,
	};
	const open = () => true;

	test("stands beside the villager instead of under the next roof", () => {
		expect(talkSpot(layout, "agent-echo", { x: 4, y: 4 }, open)).toEqual({
			facing: "left",
			point: { x: 4 + TALK_SIDE_OFFSET, y: 3 },
		});
		expect(
			talkSpot(layout, "agent-echo", { x: 4, y: 4 }, (point) => point.x < 5)
		).toEqual({
			facing: "right",
			point: { x: 4 - TALK_SIDE_OFFSET, y: 3 },
		});
	});

	test("draws the player where they are otherwise", () => {
		expect(talkSpot(layout, null, { x: 4, y: 4 }, open)).toBeNull();
		expect(talkSpot(layout, "agent-echo", { x: 5, y: 4 }, open)).toBeNull();
		expect(talkSpot(layout, "agent-echo", { x: 4, y: 4 }, () => false)).toBe(
			null
		);
	});
});

describe("world 2d controls hint", () => {
	test("starts closed on a narrow stage so it never covers the player", () => {
		expect(hintOpensByDefault(390)).toBe(false);
		expect(hintOpensByDefault(HINT_NARROW_WIDTH - 1)).toBe(false);
		expect(hintOpensByDefault(HINT_NARROW_WIDTH)).toBe(true);
		expect(hintOpensByDefault(1440)).toBe(true);
	});
});

describe("world 2d empty and loading states", () => {
	test("an empty village explains itself and offers a conversation", async () => {
		const html = render(EMPTY_SNAPSHOT);
		expect(html).toContain('aria-labelledby="world-2d-empty-title"');
		expect(html).toContain("No villagers yet");
		expect(html).toContain("Start a conversation");
		expect(html).not.toContain("world-2d-hotbar-placeholder");
		const calls: string[] = [];
		const { container, dispose } = await mount(
			<World2dInterface
				activeThreadId={null}
				loading={false}
				params={{ theme: "meadow" }}
				port={recordingPort(calls)}
				snapshot={EMPTY_SNAPSHOT}
				threadView={null}
			/>
		);
		try {
			const start = [...container.querySelectorAll("button")].find(
				(button) => button.textContent === "Start a conversation"
			);
			if (!start) {
				throw new Error("No Start a conversation button");
			}
			await click(start);
			// The host's own new-thread flow takes over: no prompt is sent.
			expect(calls).toEqual(["start:{}"]);
		} finally {
			await dispose();
		}
	});

	test("loading keeps the HUD's shape with empty hotbar wells", () => {
		const html = render(EMPTY_SNAPSHOT, true);
		expect(html).toContain('data-testid="world-2d-hotbar-placeholder"');
		expect(html).toContain('aria-busy="true"');
		expect(html).toContain("Loading villagers");
		expect(html).not.toContain("No villagers yet");
		expect(html).not.toContain("Start a conversation");
		// The wells are decoration: hidden from assistive tech, no buttons.
		expect(html).toMatch(
			/<div aria-hidden="true"[^>]*data-testid="world-2d-hotbar-placeholder"/
		);
		expect(html).not.toContain('aria-label="Villagers"');
	});
});

describe("world 2d pixel face", () => {
	test("packs every glyph into a TrueType file", () => {
		const font = buildPixelFont();
		const view = new DataView(font.buffer);
		expect(view.getUint32(0)).toBe(0x1_00_00);
		expect(view.getUint16(4)).toBe(10);
		const tags: string[] = [];
		for (let index = 0; index < 10; index++) {
			const offset = 12 + index * 16;
			tags.push(
				String.fromCharCode(...font.subarray(offset, offset + 4).values())
			);
		}
		expect(tags).toEqual([
			"OS/2",
			"cmap",
			"glyf",
			"head",
			"hhea",
			"hmtx",
			"loca",
			"maxp",
			"name",
			"post",
		]);
		const maxp = tags.indexOf("maxp");
		const maxpOffset = view.getUint32(12 + maxp * 16 + 8);
		// .notdef plus one glyph per character.
		expect(view.getUint16(maxpOffset + 4)).toBe(PIXEL_GLYPHS.length + 1);
	});

	test("glyphs stay on the 5x7 grid with two descender rows", () => {
		for (const [char, rows] of PIXEL_GLYPHS) {
			expect({ char, ok: rows.length <= 9 }).toEqual({ char, ok: true });
			for (const row of rows) {
				expect(/^[.#]+$/.test(row)).toBe(true);
			}
		}
	});
});

describe("world-2d settings", () => {
	const world = (
		params: Parameters<typeof World2dInterface>[0]["params"],
		port: InterfacePort = NOOP_PORT
	) => (
		<World2dInterface
			activeThreadId={null}
			loading={false}
			params={params}
			port={port}
			snapshot={SNAPSHOT}
			threadView={null}
		/>
	);
	const helpPressed = (container: HTMLElement) =>
		container
			.querySelector('[aria-label="Controls"]')
			?.getAttribute("aria-pressed");

	test("the controls hint follows the setting, live", async () => {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(world({ controls: "shown", theme: "meadow" }))
		);
		expect(helpPressed(container)).toBe("true");
		await act(async () =>
			root.render(world({ controls: "hidden", theme: "meadow" }))
		);
		expect(helpPressed(container)).toBe("false");
		await act(async () =>
			root.render(world({ controls: "shown", theme: "meadow" }))
		);
		expect(helpPressed(container)).toBe("true");
		await act(async () => root.unmount());
		container.remove();
	});

	test("the ? slot keeps its choice through updateSettings", async () => {
		const updates: Record<string, unknown>[] = [];
		const port: InterfacePort = {
			...NOOP_PORT,
			updateSettings: (patch) => updates.push(patch),
		};
		const { container, dispose } = await mount(
			world({ controls: "shown", theme: "meadow" }, port)
		);
		try {
			await click(byLabel(container, "Controls"));
			expect(updates).toEqual([{ controls: "hidden" }]);
			expect(helpPressed(container)).toBe("false");
		} finally {
			await dispose();
		}
	});
});
