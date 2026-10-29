import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	agentActs,
	askAriaLabel,
	askBubble,
	blockerAriaLabel,
	builtinInterfaceId,
	CONTRIBUTABLE_INTERFACE_RENDERERS,
	channelHandle,
	clockLabel,
	compareAsks,
	estimateProgress,
	FEED_EXCERPT_LIMIT,
	type InterfaceAgentAct,
	type InterfaceAsk,
	type InterfaceBlocker,
	type InterfaceEvent,
	type InterfaceSnapshot,
	type InterfaceThread,
	interfaceTier,
	isSuggestion,
	layoutWorld,
	MAX_CONTRIBUTED_INTERFACES,
	medianRunMs,
	nearestWorldEntity,
	parseInterfaceContribution,
	parseInterfaceContributions,
	projectChannels,
	projectFeed,
	resolveInterfaceParams,
	riskTagLabel,
	shortLine,
	stepKindForTool,
	stepWorldPlayer,
	unownedAsks,
	waitBand,
	waitLabel,
} from "./interfaces.ts";
import {
	FIXTURE_ASK_IDS,
	FIXTURE_CLOCK,
	FIXTURE_NOW_MS,
	FIXTURE_THREAD_IDS,
	usefulStateFixture,
} from "./interfaces-fixture.ts";

function thread(
	overrides: Partial<InterfaceThread> & { id: string }
): InterfaceThread {
	return {
		agentIds: [],
		lastMessage: null,
		lastMessageRole: null,
		messageCount: 1,
		pinned: false,
		projectId: null,
		running: false,
		teamId: null,
		title: overrides.id,
		updatedAt: "2026-10-01T00:00:00.000Z",
		...overrides,
	};
}

const snapshot: InterfaceSnapshot = {
	agents: [
		{
			avatarUrl: null,
			description: "",
			id: "ryu",
			name: "Ryu",
			status: "idle",
		},
		{
			avatarUrl: null,
			description: "",
			id: "coder",
			name: "Coder",
			status: "working",
		},
		{
			avatarUrl: null,
			description: "",
			id: "quiet",
			name: "Quiet",
			status: "idle",
		},
	],
	groups: [
		{
			id: "t1",
			kind: "team",
			memberAgentIds: ["ryu", "coder"],
			name: "Launch Crew",
		},
		{ id: "p1", kind: "project", memberAgentIds: [], name: "Website" },
	],
	threads: [
		thread({
			agentIds: ["ryu"],
			id: "a",
			messageCount: 4,
			updatedAt: "2026-10-03T00:00:00.000Z",
		}),
		thread({
			agentIds: ["coder"],
			id: "b",
			projectId: "p1",
			running: true,
			updatedAt: "2026-10-02T00:00:00.000Z",
		}),
		thread({
			agentIds: ["ryu", "coder"],
			id: "c",
			teamId: "t1",
			updatedAt: "2026-10-04T00:00:00.000Z",
		}),
		thread({ id: "d", pinned: true, updatedAt: "2026-09-01T00:00:00.000Z" }),
	],
	version: 1,
};

describe("tiers and renderers", () => {
	test("only workspace renderers are contributable", () => {
		expect(interfaceTier("console")).toBe("admin");
		expect(interfaceTier("bot")).toBe("managed");
		expect(CONTRIBUTABLE_INTERFACE_RENDERERS).toEqual([
			"os",
			"channels",
			"feed",
			"world-2d",
			"world-3d",
			"board",
			"inbox",
			"graph",
			"timeline",
			"messenger",
			"terminal",
			"arena",
			"desk",
			"card-table",
			"sheet",
			"canvas",
			"calendar",
			"notebook",
			"mission-control",
			"ticker",
			"focus",
			"aquarium",
			"planets",
			"stream",
			"forum",
			"live",
			"posts",
			"community",
			"wiki",
			"dashboard",
			"mindmap",
			"gallery",
			"newspaper",
			"qa",
			"cinema",
			"noticeboard",
			"mail",
			"status",
			"records",
			"path",
			"glance",
			"hub",
			"library",
			"tickets",
			"persona",
			"panels",
			"departures",
			"tracking",
			"flow",
			"moments",
			"kitchen",
			"market",
			"workers",
			"arcade",
			"farm",
			"town",
			"rides",
			"journal",
			"passport",
			"lobby",
			"seasonal",
			"bank",
			"quiz",
			"jobs",
			"knowledge",
			"hologram",
			"warehouse",
		]);
		expect(builtinInterfaceId("channels")).toBe("ryu:channels");
	});

	test("the newer renderers resolve their params with defaults", () => {
		expect(resolveInterfaceParams("canvas", { arrange: "agent" })).toEqual({
			arrange: "agent",
			minimap: "auto",
		});
		expect(resolveInterfaceParams("canvas", { arrange: "grid" })).toEqual({
			arrange: "status",
			minimap: "auto",
		});
		expect(resolveInterfaceParams("calendar", {})).toEqual({
			rail: true,
			scale: "month",
		});
		// Kit games also carry the kit's shared settings, at their defaults.
		const kit = { overlayDensity: "full", workBubbles: true } as const;
		expect(resolveInterfaceParams("seasonal", {})).toEqual({
			...kit,
			season: "auto",
			weather: true,
		});
		expect(resolveInterfaceParams("seasonal", { season: "halloween" })).toEqual(
			{ ...kit, season: "halloween", weather: true }
		);
		expect(resolveInterfaceParams("calendar", { scale: "week" })).toEqual({
			rail: true,
			scale: "week",
		});
		const table = { ...kit, deck: "classic", felt: "classic" } as const;
		expect(resolveInterfaceParams("card-table", { chips: 9 })).toEqual({
			...table,
			layout: "poker",
		});
		expect(resolveInterfaceParams("card-table", { layout: "spread" })).toEqual({
			...table,
			layout: "spread",
		});
	});

	test("params fall back to defaults instead of failing", () => {
		expect(
			resolveInterfaceParams("world-3d", { camera: "drone", theme: "night" })
		).toEqual({
			camera: "orbit",
			minimap: true,
			overlayDensity: "full",
			theme: "night",
			workBubbles: true,
		});
		expect(resolveInterfaceParams("feed", "not an object")).toEqual({
			order: "recent",
		});
		expect(
			resolveInterfaceParams("channels", { groupBy: "project", extra: 1 })
		).toEqual({
			groupBy: "project",
		});
	});
});

// src → packages/protocol → packages → repo root.
const REPO_ROOT = join(import.meta.dir, "../../..");
const RUST_MANIFEST_PATH = join(
	REPO_ROOT,
	"crates/core/kernel-contracts/src/manifest.rs"
);
const RUST_SERVER_PATH = join(REPO_ROOT, "apps/core/src/server/mod.rs");

describe("Rust parity", () => {
	test("contributable renderers match Core's manifest allow-list", () => {
		const source = readFileSync(RUST_MANIFEST_PATH, "utf8");
		const match = source.match(
			/pub const CONTRIBUTABLE_INTERFACE_RENDERERS: \[&str; (\d+)\] = \[([\s\S]*?)\];/
		);
		if (!match) {
			throw new Error(
				"manifest.rs no longer contains CONTRIBUTABLE_INTERFACE_RENDERERS — anchor lost"
			);
		}
		const rustRenderers: string[] = [];
		for (const entry of (match[2] ?? "").matchAll(/"([^"]+)"/g)) {
			rustRenderers.push(entry[1] ?? "");
		}
		expect(rustRenderers).toEqual([...CONTRIBUTABLE_INTERFACE_RENDERERS]);
		expect(Number(match[1])).toBe(CONTRIBUTABLE_INTERFACE_RENDERERS.length);
	});

	test("contributed interface cap matches Core's per-response row cap", () => {
		const source = readFileSync(RUST_SERVER_PATH, "utf8");
		const match = source.match(
			/const MAX_PLUGIN_INTERFACE_ROWS_PER_RESPONSE: usize = (\d+);/
		);
		if (!match) {
			throw new Error(
				"mod.rs no longer contains MAX_PLUGIN_INTERFACE_ROWS_PER_RESPONSE — anchor lost"
			);
		}
		expect(Number(match[1])).toBe(MAX_CONTRIBUTED_INTERFACES);
	});
});

describe("parseInterfaceContribution", () => {
	const valid = {
		id: "@acme/pixel-town:town",
		label: "Pixel Town",
		params: { theme: "night" },
		plugin: "@acme/pixel-town",
		renderer: "world-2d",
	};

	test("accepts a namespaced workspace interface", () => {
		expect(parseInterfaceContribution(valid)).toEqual({
			description: "",
			id: "@acme/pixel-town:town",
			label: "Pixel Town",
			origin: "marketplace",
			params: { theme: "night" },
			plugin: "@acme/pixel-town",
			renderer: "world-2d",
		});
	});

	test("rejects host-only renderers, foreign namespaces, and unknown renderers", () => {
		expect(
			parseInterfaceContribution({ ...valid, renderer: "console" })
		).toBeNull();
		expect(
			parseInterfaceContribution({ ...valid, renderer: "bot" })
		).toBeNull();
		expect(
			parseInterfaceContribution({ ...valid, renderer: "html" })
		).toBeNull();
		expect(
			parseInterfaceContribution({ ...valid, id: "ryu:channels" })
		).toBeNull();
		expect(
			parseInterfaceContribution({ ...valid, id: "@other/plugin:town" })
		).toBeNull();
		// A plugin literally named `ryu` must not claim the built-in namespace.
		expect(
			parseInterfaceContribution({ ...valid, id: "ryu:feed", plugin: "ryu" })
		).toBeNull();
		expect(
			parseInterfaceContribution({
				...valid,
				id: "ryu:anything",
				plugin: "ryu",
			})
		).toBeNull();
		expect(parseInterfaceContribution({ ...valid, label: "" })).toBeNull();
	});

	test("drops oversized params rather than the whole interface", () => {
		const parsed = parseInterfaceContribution({
			...valid,
			params: { blob: "x".repeat(5000) },
		});
		expect(parsed?.params).toEqual({});
	});

	test("list parsing dedupes ids and ignores non-arrays", () => {
		expect(parseInterfaceContributions({})).toEqual([]);
		expect(
			parseInterfaceContributions([valid, valid, { bad: true }])
		).toHaveLength(1);
	});
});

describe("projectChannels", () => {
	test("teams are channels, agents are DMs, orphans land in #general", () => {
		const [channels, direct] = projectChannels(snapshot, { groupBy: "agent" });
		expect(channels?.channels.map((channel) => channel.id)).toEqual([
			"team:t1",
			"general",
		]);
		expect(channels?.channels[0]?.threadIds).toEqual(["c"]);
		expect(direct?.channels.map((channel) => channel.id)).toEqual([
			"agent:ryu",
			"agent:coder",
			"agent:quiet",
		]);
		expect(direct?.channels.find((c) => c.id === "agent:coder")?.running).toBe(
			true
		);
		expect(
			direct?.channels.find((c) => c.id === "agent:quiet")?.threadIds
		).toEqual([]);
	});

	test("project grouping moves project threads out of DMs", () => {
		const [channels, direct] = projectChannels(snapshot, {
			groupBy: "project",
		});
		expect(
			channels?.channels.find((c) => c.id === "project:p1")?.threadIds
		).toEqual(["b"]);
		expect(
			direct?.channels.find((c) => c.id === "agent:coder")?.threadIds
		).toEqual([]);
	});

	test("handles are slack-style", () => {
		expect(channelHandle("Launch Crew!")).toBe("launch-crew");
		expect(channelHandle("***")).toBe("channel");
	});
});

describe("projectFeed", () => {
	test("pinned first, then recency; replies exclude the opening post", () => {
		const posts = projectFeed(snapshot, { order: "recent" });
		expect(posts.map((post) => post.threadId)).toEqual(["d", "c", "a", "b"]);
		expect(posts.find((post) => post.threadId === "a")?.replyCount).toBe(3);
	});

	test("active order lifts running threads", () => {
		const posts = projectFeed(snapshot, { order: "active" });
		expect(posts.map((post) => post.threadId)).toEqual(["d", "b", "c", "a"]);
	});

	test("excerpts are flattened and bounded", () => {
		const long = {
			...snapshot,
			threads: [thread({ id: "x", lastMessage: `a\n\n${"b".repeat(400)}` })],
		};
		const [post] = projectFeed(long, { order: "recent" });
		expect(post?.excerpt.length).toBe(FEED_EXCERPT_LIMIT);
		expect(post?.excerpt.startsWith("a b")).toBe(true);
	});
});

describe("world layout", () => {
	test("is deterministic, stable while agents work, and leaves a plaza", () => {
		const layout = layoutWorld(snapshot);
		expect(layoutWorld(snapshot)).toEqual(layout);
		expect(layout.entities.map((e) => e.agentId)).toEqual([
			"coder",
			"quiet",
			"ryu",
		]);
		const busy = {
			...snapshot,
			agents: snapshot.agents.map((agent) => ({
				...agent,
				status: "working" as const,
			})),
		};
		expect(
			layoutWorld(busy).entities.map(({ agentId, x, y }) => ({ agentId, x, y }))
		).toEqual(layout.entities.map(({ agentId, x, y }) => ({ agentId, x, y })));
		expect(layout.width).toBeGreaterThanOrEqual(13);
		const occupied = new Set(layout.entities.map((e) => `${e.x},${e.y}`));
		expect(occupied.size).toBe(layout.entities.length);
		expect(occupied.has(`${layout.spawn.x},${layout.spawn.y}`)).toBe(false);
		for (const entity of layout.entities) {
			expect(entity.x).toBeLessThan(layout.width);
			expect(entity.y).toBeLessThan(layout.spawn.y);
		}
	});

	test("movement is bounded and agents block their tile", () => {
		const layout = layoutWorld(snapshot);
		const [entity] = layout.entities;
		if (!entity) {
			throw new Error("expected an entity");
		}
		const below = { x: entity.x, y: entity.y + 1 };
		expect(stepWorldPlayer(layout, below, "up")).toEqual(below);
		expect(nearestWorldEntity(layout, below)?.agentId).toBe(entity.agentId);
		expect(stepWorldPlayer(layout, { x: 0, y: 0 }, "left")).toEqual({
			x: 0,
			y: 0,
		});
		expect(nearestWorldEntity(layout, layout.spawn, 0)).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Useful state (spec docs/interfaces-useful-state.md §2.1, §7.2)
// ---------------------------------------------------------------------------

const NOW = FIXTURE_NOW_MS;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(ms).toISOString();

function actsOf(
	fixture: InterfaceSnapshot = usefulStateFixture(),
	nowMs = NOW
): Map<string, InterfaceAgentAct> {
	return agentActs(fixture, nowMs, FIXTURE_CLOCK);
}

function actOf(
	acts: Map<string, InterfaceAgentAct>,
	id: string
): InterfaceAgentAct {
	const found = acts.get(id);
	if (!found) {
		throw new Error(`no act for ${id}`);
	}
	return found;
}

function askOf(fixture: InterfaceSnapshot, id: string): InterfaceAsk {
	const found = fixture.asks?.find((ask) => ask.id === id);
	if (!found) {
		throw new Error(`no ask ${id}`);
	}
	return found;
}

function makeAsk(
	overrides: Partial<InterfaceAsk> & { id: string }
): InterfaceAsk {
	return {
		agentId: null,
		blocking: true,
		kind: "approval",
		since: null,
		source: "approvals",
		text: overrides.id,
		threadId: null,
		...overrides,
	};
}

function miniSnapshot(
	agentIds: string[],
	threads: InterfaceThread[],
	asks: InterfaceAsk[] = []
): InterfaceSnapshot {
	return {
		agents: agentIds.map((id) => ({
			avatarUrl: null,
			description: "",
			id,
			name: id.toUpperCase(),
			status: "idle",
		})),
		asks,
		groups: [],
		threads,
		version: 1,
	};
}

/** Replace one thread of the fixture. */
function withThread(
	fixture: InterfaceSnapshot,
	id: string,
	patch: Partial<InterfaceThread>
): InterfaceSnapshot {
	return {
		...fixture,
		threads: fixture.threads.map((item) =>
			item.id === id ? { ...item, ...patch } : item
		),
	};
}

describe("agentActs priority table (test 1)", () => {
	test("each fixture agent gets its act", () => {
		const acts = actsOf();
		expect(
			Object.fromEntries([...acts].map(([id, item]) => [id, item.act]))
		).toEqual({
			ada: "asking",
			bo: "asking",
			cy: "working",
			di: "blocked",
			ed: "blocked",
			fa: "limited",
			gu: "delivering",
			ha: "idle",
			io: "working",
			ju: "idle",
		});
	});

	test("Ha is idle with one old failure and one suggestion that is never parked", () => {
		const ha = actOf(actsOf(), "ha");
		expect(ha.pending).toEqual({
			asks: 0,
			blocked: 0,
			old: 1,
			suggestions: 1,
			unread: 0,
		});
		expect(ha.blockers).toEqual([]);
		expect(ha.parkedAsks).toEqual([]);
		expect(ha.suggestions.map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.haHeal,
		]);
		expect(ha.bubble).toBeNull();
	});

	test("Ju's reply older than 24 h does not walk", () => {
		const ju = actOf(actsOf(), "ju");
		expect(ju.act).toBe("idle");
		expect(ju.pending.unread).toBe(1);
		expect(ju.ask).toBeNull();
	});

	test("Ha's read answer yields no ask, and Gu's thread yields exactly one item", () => {
		const fixture = usefulStateFixture();
		expect(
			fixture.asks?.filter((ask) => ask.threadId === FIXTURE_THREAD_IDS.ha)
		).toEqual([]);
		expect(
			fixture.asks?.filter((ask) => ask.threadId === FIXTURE_THREAD_IDS.gu)
		).toHaveLength(1);
		const gu = actOf(actsOf(fixture), "gu");
		expect(gu.ask?.id).toBe(FIXTURE_ASK_IDS.guReply);
		expect(gu.carry).toBe("deliverable");
		expect(gu.pending.unread).toBe(0);
		expect(gu.bubble).toEqual({
			partial: false,
			text: "3 files edited",
			tone: "done",
		});
	});

	test("Di's focus is the newest counted failure", () => {
		const di = actOf(actsOf(), "di");
		expect(di.blockers.map((blocker) => blocker.title)).toEqual([
			"Tests failed",
			"Nightly backup failed",
		]);
		expect(di.pending.blocked).toBe(1);
		expect(di.threadId).toBe(FIXTURE_THREAD_IDS.di);
		expect(di.bubble).toEqual({
			partial: false,
			text: "Tests failed",
			tone: "error",
		});
	});

	test("a shared team thread produces exactly one act", () => {
		const shared = thread({
			agentIds: ["x", "y"],
			blocker: {
				at: at(NOW - 5 * MINUTE),
				kind: "error",
				source: "messages",
				title: "Broke",
			},
			id: "team-thread",
			runState: "failed",
			updatedAt: at(NOW - 5 * MINUTE),
		});
		const acts = actsOf(miniSnapshot(["x", "y"], [shared]));
		expect(actOf(acts, "x").act).toBe("blocked");
		expect(actOf(acts, "y").act).toBe("idle");
		expect(actOf(acts, "y").blockers).toEqual([]);
	});

	test("a running agent with a recent failed thread is working with that failure pending", () => {
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						id: "live",
						running: true,
						updatedAt: at(NOW),
					}),
					thread({
						agentIds: ["x"],
						blocker: {
							at: at(NOW - 10 * MINUTE),
							kind: "tool-failed",
							source: "messages",
							title: "Edit failed",
						},
						id: "broken",
						runState: "failed",
						updatedAt: at(NOW - 10 * MINUTE),
					}),
				]
			)
		);
		const x = actOf(acts, "x");
		expect(x.act).toBe("working");
		expect(x.pending.blocked).toBe(1);
		expect(x.blockers).toHaveLength(1);
		expect(x.threadId).toBe("live");
	});

	test("a tool_call approval on a running agent is parked, not carried", () => {
		const toolCall = makeAsk({
			agentId: "x",
			holdsRun: false,
			id: "approval:t",
			since: at(NOW - 2 * MINUTE),
			subject: "tool_call",
			text: "Can I run `shell.run` now?",
			threadId: "live",
		});
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						id: "live",
						running: true,
						updatedAt: at(NOW),
					}),
				],
				[toolCall]
			)
		);
		const x = actOf(acts, "x");
		expect(x.act).toBe("working");
		expect(x.ask).toBeNull();
		expect(x.parkedAsks).toEqual([toolCall]);
		expect(x.pending.asks).toBe(1);
		expect(x.ariaLabel).toContain(" Ask waiting: Can I run shell.run now?");
		expect(x.ariaLabel).not.toContain("more asks");
	});

	test("Bo's blocking question holds its run, so Bo is asking", () => {
		const bo = actOf(actsOf(), "bo");
		expect(bo.act).toBe("asking");
		expect(bo.ask?.id).toBe(FIXTURE_ASK_IDS.boQuestion);
		expect(bo.carry).toBe("question");
		expect(bo.timer).toEqual({
			approx: false,
			since: at(NOW - 3 * MINUTE),
			until: at(NOW + 7 * MINUTE),
			untilApprox: true,
		});
		expect(bo.bubble).toEqual({
			partial: false,
			text: "Which DB to use?",
			tone: "ask",
		});
	});

	test("Bo's deferred question is a suggestion and Bo keeps working", () => {
		const fixture = usefulStateFixture();
		const deferred = fixture.asks?.map((ask): InterfaceAsk => {
			if (ask.id !== FIXTURE_ASK_IDS.boQuestion) {
				return ask;
			}
			const {
				choices: _choices,
				expiresAt: _expiresAt,
				expiresApprox: _approx,
				...rest
			} = ask;
			return { ...rest, blocking: false, holdsRun: false };
		});
		const variant = { ...fixture, asks: deferred };
		const bo = actOf(actsOf(variant), "bo");
		expect(bo.act).toBe("working");
		expect(bo.pending.suggestions).toBe(1);
		expect(bo.parkedAsks).toEqual([]);
		const ask = askOf(variant, FIXTURE_ASK_IDS.boQuestion);
		expect(isSuggestion(ask)).toBe(true);
		expect(askAriaLabel(ask, "Bo", NOW)).toBe(
			"Bo has a question when you have time: Which DB to use? Waiting 3 minutes."
		);
	});

	test("with livePermission Ada carries the permission and parks the tool_call", () => {
		const ada = actOf(
			actsOf(usefulStateFixture({ livePermission: true })),
			"ada"
		);
		expect(ada.act).toBe("asking");
		expect(ada.ask?.id).toBe(FIXTURE_ASK_IDS.adaPermission);
		expect(ada.parkedAsks.map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		expect(ada.pending.asks).toBe(1);
		expect(ada.carry).toBe("approval");
		expect(ada.ariaLabel).toContain(" Ask waiting: Can I run shell.run now?");
	});

	test("the blocker counting rule", () => {
		const old = (unread: number, blockerAt: string | null, updatedAt: string) =>
			actOf(
				actsOf(
					miniSnapshot(
						["x"],
						[
							thread({
								agentIds: ["x"],
								blocker: {
									at: blockerAt,
									kind: "error",
									source: "run-stream",
									title: "Run failed",
								},
								id: "f",
								runState: "failed",
								unread,
								updatedAt,
							}),
						]
					)
				),
				"x"
			);
		const dayAgo = at(NOW - 25 * HOUR);
		expect(old(1, dayAgo, dayAgo).act).toBe("blocked");
		expect(old(0, dayAgo, dayAgo).act).toBe("idle");
		expect(old(0, dayAgo, dayAgo).pending.old).toBe(1);
		expect(old(0, null, at(NOW - 2 * HOUR)).act).toBe("blocked");
		expect(old(0, null, dayAgo).pending.old).toBe(1);
		// A recent `at` counts even when the thread moved long ago.
		expect(old(0, at(NOW - HOUR), dayAgo).act).toBe("blocked");
	});

	test("the workflow gate produces no act", () => {
		const acts = actsOf();
		expect(acts.size).toBe(10);
		for (const item of acts.values()) {
			expect(item.ask?.id).not.toBe(FIXTURE_ASK_IDS.workflowGate);
			expect(item.parkedAsks.map((ask) => ask.id)).not.toContain(
				FIXTURE_ASK_IDS.workflowGate
			);
		}
	});

	test("elapsed only for an exact run start", () => {
		const acts = actsOf();
		expect(actOf(acts, "cy").elapsed).toBe("12m");
		expect(actOf(acts, "io").elapsed).toBeNull();
		expect(actOf(acts, "io").bubble).toEqual({
			partial: true,
			text: "Working on Fix login",
			tone: "work",
		});
		expect(actOf(acts, "cy").carry).toBe("edit");
		expect(actOf(acts, "cy").next).toBe("Next: write tests");
	});

	test("stalled: no progress for 10 minutes on a hydrated thread", () => {
		const fixture = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.cy, {
			lastProgressAt: at(NOW - 12 * MINUTE),
		});
		const cy = actOf(actsOf(fixture), "cy");
		expect(cy.act).toBe("working");
		expect(cy.stalled).toBe(true);
		expect(cy.stalledFor).toBe("12 minutes");
		expect(cy.bubble).toBeNull();
		expect(
			cy.ariaLabel.startsWith(
				"Cy shows no progress for 12 minutes; the run may have stopped. "
			)
		).toBe(true);
		const io = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.io, {
			lastProgressAt: at(NOW - 30 * MINUTE),
		});
		expect(actOf(actsOf(io), "io").stalled).toBe(false);
	});

	test("longer than usual only for a routine run past twice its median", () => {
		const later = actsOf(usefulStateFixture(), NOW + 30 * MINUTE);
		expect(actOf(later, "io").longerThanUsual).toBe(true);
		expect(actOf(later, "io").ariaLabel).toContain(", longer than usual.");
		expect(actOf(later, "cy").longerThanUsual).toBe(false);
		expect(actOf(actsOf(), "io").longerThanUsual).toBe(false);
	});

	test("Fa limit precedence as host inputs", () => {
		const resetsAt = Date.parse("2026-10-16T15:10:00Z");
		const errorAt = at(NOW - HOUR);
		const inferred = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.fa, {
			blocker: {
				at: errorAt,
				atApprox: true,
				clearsAt: at(resetsAt),
				detail: "The agent stopped with an error.",
				kind: "rate-limited",
				source: "estimate",
				title: "Limit hit",
			},
			runState: "failed",
		});
		const fa = actOf(actsOf(inferred), "fa");
		expect(fa.act).toBe("limited");
		expect(fa.blockers[0]?.source).toBe("estimate");
		expect(fa.bubble).toEqual({
			partial: false,
			text: "Likely limit, back 15:10",
			tone: "limit",
		});
		expect(fa.timer?.until).toBe(at(resetsAt));
		const kept = withThread(usefulStateFixture(), FIXTURE_THREAD_IDS.fa, {
			blocker: {
				at: errorAt,
				kind: "error",
				source: "messages",
				title: "Agent error",
			},
			runState: "failed",
		});
		expect(actOf(actsOf(kept), "fa").act).toBe("blocked");
		const plain = actOf(actsOf(), "fa");
		expect(plain.timer).toEqual({
			approx: false,
			since: null,
			until: at(resetsAt),
			untilApprox: false,
		});
		expect(plain.bubble?.text).toBe("Limit hit, back 15:10");
	});
});

describe("agentActs ariaLabel template (test 1)", () => {
	const full: Record<string, string> = {
		ada: "Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run.",
		bo: "Bo asks: Which DB to use? Waited 3 minutes. Expires within 7 minutes.",
		cy: "Cy is editing snapshot.ts, step 3 of 7, running 12 minutes. 2 helpers running. Next: write tests.",
		di: "Di stopped: Tests failed, 20 minutes ago. Also: 1 failed thread.",
		ed: "Ed stopped: Interrupted, about 1 hour ago.",
		fa: "Fa hit a usage limit (Weekly), back 15:10.",
		gu: "Gu has an answer ready: Edited 3 files. 3 files changed.",
		ha: "Ha is idle. Also: 1 suggestion, 1 older failure.",
		io: "Io is working on Fix login flow, progress estimated.",
		ju: "Ju is idle. Also: 1 unread answer.",
	};
	const redacted: Record<string, string> = {
		ada: "Ada: Needs approval. Waited 14 minutes. Risk: run.",
		bo: "Bo: Question for you. Waited 3 minutes. Expires within 7 minutes.",
		cy: "Cy is working, step 3 of 7, running 12 minutes. 2 helpers running. Next run tomorrow 09:00.",
		di: "Di stopped: Failed, 20 minutes ago. Also: 1 failed thread.",
		ed: "Ed stopped: Interrupted, about 1 hour ago.",
		fa: "Fa hit a usage limit (Weekly), back 15:10.",
		gu: "Gu has an answer ready.",
		ha: "Ha is idle. Also: 1 suggestion, 1 older failure.",
		io: "Io is working, progress estimated.",
		ju: "Ju is idle. Also: 1 unread answer.",
	};

	test("full column", () => {
		const acts = actsOf();
		for (const [id, sentence] of Object.entries(full)) {
			expect(actOf(acts, id).ariaLabel).toBe(sentence);
		}
	});

	test("redacted column", () => {
		const acts = actsOf(usefulStateFixture({ privacy: "redacted" }));
		for (const [id, sentence] of Object.entries(redacted)) {
			expect(actOf(acts, id).ariaLabel).toBe(sentence);
		}
		expect(actOf(acts, "ada").bubble?.text).toBe("Needs approval");
		expect(actOf(acts, "io").bubble?.text).toBe("Working");
	});

	test("waiting variant", () => {
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						id: "sent",
						lastMessageRole: "user",
						updatedAt: at(NOW - MINUTE),
					}),
				]
			)
		);
		const x = actOf(acts, "x");
		expect(x.act).toBe("waiting");
		expect(x.ariaLabel).toBe("X has your message and has not started.");
		expect(x.bubble).toEqual({
			partial: false,
			text: "Picking this up",
			tone: "wait",
		});
	});

	test("markdown is stripped from sentences", () => {
		const ask = makeAsk({
			agentId: "x",
			id: "approval:md",
			since: at(NOW - MINUTE),
			text: "**Can** I [deploy](https://example.com) `prod`?",
		});
		const x = actOf(actsOf(miniSnapshot(["x"], [], [ask])), "x");
		expect(x.ariaLabel).toBe("X asks: Can I deploy prod? Waited 1 minute.");
	});
});

describe("compareAsks (test 2)", () => {
	const blockingIds = (fixture: InterfaceSnapshot) =>
		[...(fixture.asks ?? [])]
			.filter((ask) => ask.blocking)
			.sort(compareAsks)
			.map((ask) => ask.id);

	test("deadline first, then oldest", () => {
		expect(blockingIds(usefulStateFixture())).toEqual([
			FIXTURE_ASK_IDS.boQuestion,
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
		expect(blockingIds(usefulStateFixture({ livePermission: true }))).toEqual([
			FIXTURE_ASK_IDS.adaPermission,
			FIXTURE_ASK_IDS.boQuestion,
			FIXTURE_ASK_IDS.workflowGate,
			FIXTURE_ASK_IDS.adaToolCall,
		]);
	});

	test("null since last, ties by id, earlier deadline first, blocking before non-blocking", () => {
		const a = makeAsk({ id: "a", since: null });
		const b = makeAsk({ id: "b", since: at(NOW - MINUTE) });
		const c = makeAsk({ id: "c", since: at(NOW - MINUTE) });
		expect([a, c, b].sort(compareAsks).map((ask) => ask.id)).toEqual([
			"b",
			"c",
			"a",
		]);
		const soon = makeAsk({ expiresAt: at(NOW + MINUTE), id: "soon" });
		const later = makeAsk({ expiresAt: at(NOW + HOUR), id: "later" });
		expect([later, soon].sort(compareAsks).map((ask) => ask.id)).toEqual([
			"soon",
			"later",
		]);
		const suggestion = makeAsk({
			blocking: false,
			expiresAt: at(NOW + MINUTE),
			id: "s",
		});
		expect([suggestion, a].sort(compareAsks).map((ask) => ask.id)).toEqual([
			"a",
			"s",
		]);
	});

	test("the order does not depend on the clock", () => {
		const asks = usefulStateFixture({ livePermission: true }).asks ?? [];
		const first = [...asks].sort(compareAsks).map((ask) => ask.id);
		const second = [...asks]
			.reverse()
			.sort(compareAsks)
			.map((ask) => ask.id);
		expect(second).toEqual(first);
	});
});

describe("waitBand and waitLabel (test 3)", () => {
	test("age bands at their boundaries", () => {
		const band = (ageMs: number) => waitBand(NOW - ageMs, NOW);
		expect(band(5 * MINUTE - 1000)).toBe("fresh");
		expect(band(5 * MINUTE)).toBe("waiting");
		expect(band(59 * MINUTE)).toBe("waiting");
		expect(band(60 * MINUTE)).toBe("long");
		expect(band(23 * HOUR)).toBe("long");
		expect(band(24 * HOUR)).toBe("stale");
		expect(waitBand(null, NOW)).toBe("unknown");
	});

	test("expiring only in the last 2 minutes", () => {
		expect(waitBand(NOW - HOUR, NOW, NOW + 2 * MINUTE)).toBe("expiring");
		expect(waitBand(NOW - HOUR, NOW, NOW + 2 * MINUTE + 1000)).toBe("long");
		expect(waitBand(NOW, NOW, NOW + 10 * MINUTE)).toBe("fresh");
		expect(waitBand(NOW - 3 * MINUTE, NOW, NOW + 7 * MINUTE)).toBe("fresh");
		expect(waitBand(NOW - 7 * MINUTE, NOW, NOW + 3 * MINUTE)).toBe("waiting");
		expect(waitBand(null, NOW, NOW + MINUTE)).toBe("expiring");
	});

	test("labels", () => {
		expect(waitLabel(at(NOW - 14 * MINUTE), NOW)).toBe("14m");
		expect(waitLabel(at(NOW - 3 * HOUR), NOW)).toBe("3h");
		expect(waitLabel(at(NOW - 2 * DAY), NOW)).toBe("2d");
		expect(waitLabel(at(NOW - 14 * MINUTE), NOW, { approx: true })).toBe(
			"~14m"
		);
		expect(waitLabel(null, NOW, { until: at(NOW + 4 * MINUTE) })).toBe("in 4m");
		expect(
			waitLabel(null, NOW, { until: at(NOW + 4 * MINUTE), untilApprox: true })
		).toBe("≤ 4m");
		expect(waitLabel(at(NOW - 14 * MINUTE), NOW, { long: true })).toBe(
			"14 minutes"
		);
		expect(waitLabel(at(NOW - HOUR), NOW, { long: true })).toBe("1 hour");
		expect(
			waitLabel(at(NOW - 30 * HOUR), NOW, { approx: true, long: true })
		).toBe("about 1 day");
		expect(waitLabel(null, NOW)).toBeNull();
	});
});

describe("clockLabel (test 3b)", () => {
	test("same day, tomorrow, weekday, date", () => {
		const label = (iso: string) => clockLabel(iso, NOW, FIXTURE_CLOCK);
		expect(label("2026-10-16T15:10:00Z")).toBe("15:10");
		expect(label("2026-10-17T09:00:00Z")).toBe("tomorrow 09:00");
		expect(label("2026-10-19T09:00:00Z")).toBe("Mon 09:00");
		expect(label("2026-10-26T09:00:00Z")).toBe("26 Oct 09:00");
	});

	test("a 12-hour locale keeps the hour", () => {
		const label = clockLabel("2026-10-16T15:10:00Z", NOW, {
			locale: "en-US",
			timeZone: "UTC",
		});
		expect(label).toContain("3:10");
		expect(label).toMatch(/pm/i);
	});

	test("the day comparison uses the time zone", () => {
		expect(
			clockLabel("2026-10-16T23:30:00Z", NOW, {
				locale: "en-GB",
				timeZone: "Asia/Tokyo",
			})
		).toBe("tomorrow 08:30");
	});
});

describe("wording helpers (test 4)", () => {
	test("shortLine keeps at most 5 words and leads with a verb for tool labels", () => {
		expect(shortLine("one two three four five six seven")).toBe(
			"one two three four five…"
		);
		expect(shortLine("Bash: bun test")).toBe("Running bun test");
		expect(shortLine("Edit: snapshot.ts")).toBe("Editing snapshot.ts");
		expect(shortLine("a b c d e f", 3)).toBe("a b c…");
	});

	test("askBubble", () => {
		const fixture = usefulStateFixture();
		const ada = askOf(fixture, FIXTURE_ASK_IDS.adaToolCall);
		expect(askBubble(ada)).toBe("Run deploy.sh?");
		expect(askBubble({ ...ada, target: null })).toBe(
			"Can I run shell.run now?"
		);
		expect(askBubble(ada, "redacted")).toBe("Needs approval");
		expect(
			askBubble(askOf(fixture, FIXTURE_ASK_IDS.boQuestion), "redacted")
		).toBe("Question for you");
		for (const ask of fixture.asks ?? []) {
			const owner = fixture.threads.find((item) => item.id === ask.threadId);
			expect(askBubble(ask).split(" ").length).toBeLessThanOrEqual(5);
			expect(askBubble(ask)).not.toBe(owner?.lastMessage ?? "");
		}
	});

	test("askAriaLabel phrasings", () => {
		const fixture = usefulStateFixture({ livePermission: true });
		const ask = (id: string) => askOf(fixture, id);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.adaToolCall), "Ada", NOW)).toBe(
			"Ada asks: Can I run shell.run now? Target: deploy.sh. Waited 14 minutes. Risk: run."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.boQuestion), "Bo", NOW)).toBe(
			"Bo asks: Which DB to use? Waited 3 minutes. Expires within 7 minutes."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.workflowGate), null, NOW)).toBe(
			"Inbox asks: Workflow gate: Deploy. Waited 20 minutes. Risk: workflow."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.adaPermission), "Ada", NOW)).toBe(
			"Ada asks: Allow Edit deploy.sh? Waited about 7 minutes. Expires within 3 minutes."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.guReply), "Gu", NOW)).toBe(
			"Gu has an answer ready: Edited 3 files. Waiting 40 minutes."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.juReply), "Ju", NOW)).toBe(
			"Ju has an answer ready: Here is the weekly report summary you asked for. Waiting about 1 day."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.haHeal), "Ha", NOW)).toBe(
			"Ha suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		expect(askAriaLabel(ask(FIXTURE_ASK_IDS.haHeal), null, NOW)).toBe(
			"Inbox suggests: Apply the fix for Daily digest? Waiting 2 hours."
		);
		expect(
			askAriaLabel(ask(FIXTURE_ASK_IDS.adaToolCall), "Ada", NOW, "redacted")
		).toBe("Ada asks: Needs approval. Waited 14 minutes. Risk: run.");
		expect(
			askAriaLabel(ask(FIXTURE_ASK_IDS.adaPermission), "Ada", NOW)
		).not.toBe(askAriaLabel(ask(FIXTURE_ASK_IDS.adaToolCall), "Ada", NOW));
	});

	test("blockerAriaLabel", () => {
		const di = actOf(actsOf(), "di").blockers[0] as InterfaceBlocker;
		const ed = actOf(actsOf(), "ed").blockers[0] as InterfaceBlocker;
		expect(blockerAriaLabel(di, "Di", NOW)).toBe(
			"Di stopped: Tests failed, 20 minutes ago."
		);
		expect(blockerAriaLabel(ed, "Ed", NOW)).toBe(
			"Ed stopped: Interrupted, about 1 hour ago."
		);
		expect(blockerAriaLabel({ ...di, at: null }, "Di", NOW)).toBe(
			"Di stopped: Tests failed."
		);
		expect(blockerAriaLabel(di, "Di", NOW, "redacted")).toBe(
			"Di stopped: Failed, 20 minutes ago."
		);
		expect(
			blockerAriaLabel(
				{
					at: at(NOW - HOUR),
					atApprox: true,
					clearsAt: "2026-10-16T15:10:00Z",
					kind: "rate-limited",
					source: "estimate",
					title: "Limit hit",
				},
				"Fa",
				NOW,
				"full",
				FIXTURE_CLOCK
			)
		).toBe("Fa stopped, likely limit hit, about 1 hour ago. Clears 15:10.");
	});

	test("riskTagLabel", () => {
		expect(riskTagLabel("force_push")).toBe("force push");
		expect(riskTagLabel("agent-configuration")).toBe("agent configuration");
		expect(riskTagLabel("a__b--c")).toBe("a b c");
	});
});

describe("stepKindForTool (test 5)", () => {
	test("canonical tool names and ACP kinds", () => {
		const table: [string | null, string | null, string][] = [
			["Bash", null, "run"],
			["Read", null, "read"],
			["Write", null, "write"],
			["Edit", null, "edit"],
			["MultiEdit", null, "edit"],
			["Grep", null, "search"],
			["Glob", null, "read"],
			["WebFetch", null, "web"],
			["WebSearch", null, "search"],
			["TodoWrite", null, "plan"],
			["Thinking", null, "think"],
			["Question", null, "ask"],
			["AskUserQuestion", null, "ask"],
			["Task", null, "delegate"],
			["threads.create_thread", null, "delegate"],
			["send_message_to_thread", null, "delegate"],
			["acp-plan", null, "plan"],
			["mcp__browser__navigate", null, "web"],
			[null, "read", "read"],
			[null, "edit", "edit"],
			[null, "delete", "edit"],
			[null, "move", "edit"],
			[null, "execute", "run"],
			[null, "search", "search"],
			[null, "fetch", "web"],
			["mcp__github__create_pull_request", null, "tool"],
			["SomethingNew", "other", "tool"],
			[null, null, "tool"],
		];
		for (const [tool, acp, kind] of table) {
			expect(stepKindForTool(tool, acp)).toBe(
				kind as ReturnType<typeof stepKindForTool>
			);
		}
	});
});

describe("medianRunMs and estimateProgress (test 6)", () => {
	const events = usefulStateFixture().events as InterfaceEvent[];

	test("per routine, raw, and null without history", () => {
		expect(medianRunMs(events, { jobId: "job-login" })).toBe(20 * MINUTE);
		expect(medianRunMs(events, { jobId: "job-unknown" })).toBeNull();
		expect(medianRunMs(undefined, { jobId: "job-login" })).toBeNull();
		// agentId alone pools both of Io's routines (the legacy callers).
		expect(medianRunMs(events, { agentId: "io" })).toBe(
			(20 * MINUTE + 2 * HOUR) / 2
		);
	});

	test("Io's estimate uses its own routine from the fire time", () => {
		const fixture = usefulStateFixture();
		const io = fixture.threads.find(
			(item) => item.id === FIXTURE_THREAD_IDS.io
		) as InterfaceThread;
		const progress = estimateProgress(io, NOW, events);
		expect(progress?.kind).toBe("estimate");
		expect((progress?.done ?? 0) / (progress?.total ?? 1)).toBeCloseTo(0.75);
		const late = estimateProgress(io, NOW + 3 * HOUR, events);
		expect((late?.done ?? 0) / (late?.total ?? 1)).toBeCloseTo(0.94);
		const cy = fixture.threads.find(
			(item) => item.id === FIXTURE_THREAD_IDS.cy
		) as InterfaceThread;
		expect(estimateProgress(cy, NOW, events)).toBeNull();
		expect(estimateProgress(io, NOW, [])).toBeNull();
		expect(actOf(actsOf(fixture), "io").progress?.kind).toBe("estimate");
	});
});

describe("ownership and the need-you count (tests 17, 18)", () => {
	test("unownedAsks returns the workflow gate, plus an ask whose agent is unknown", () => {
		const fixture = usefulStateFixture();
		expect(unownedAsks(fixture).map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.workflowGate,
		]);
		const ghost = makeAsk({
			agentId: "ghost",
			id: "approval:ghost",
			since: at(NOW - MINUTE),
		});
		const variant = { ...fixture, asks: [...(fixture.asks ?? []), ghost] };
		expect(unownedAsks(variant).map((ask) => ask.id)).toEqual([
			FIXTURE_ASK_IDS.workflowGate,
			"approval:ghost",
		]);
		expect((variant.asks ?? []).filter((ask) => ask.blocking)).toHaveLength(4);
	});

	test("an ask with an unknown agent falls back to its thread's agent", () => {
		const ask = makeAsk({ agentId: "ghost", id: "approval:t", threadId: "t" });
		const snap = miniSnapshot(
			["x"],
			[thread({ agentIds: ["x"], id: "t", updatedAt: at(NOW) })],
			[ask]
		);
		expect(unownedAsks(snap)).toEqual([]);
		expect(actOf(actsOf(snap), "x").ask?.id).toBe("approval:t");
	});

	test("needYou counts blocking asks only", () => {
		const blocking = (fixture: InterfaceSnapshot) =>
			(fixture.asks ?? []).filter((ask) => ask.blocking).length;
		expect(blocking(usefulStateFixture())).toBe(3);
		expect(blocking(usefulStateFixture({ livePermission: true }))).toBe(4);
		expect(
			isSuggestion(askOf(usefulStateFixture(), FIXTURE_ASK_IDS.haHeal))
		).toBe(true);
		expect(
			isSuggestion(askOf(usefulStateFixture(), FIXTURE_ASK_IDS.guReply))
		).toBe(false);
	});
});

describe("review follow-ups", () => {
	test("questions and titles that start with a tool name keep their first word", () => {
		for (const text of [
			"Write tests first?",
			"Read the spec now?",
			"Edit the config?",
			"Task list looks right?",
		]) {
			expect(shortLine(text)).toBe(text);
			expect(
				askBubble(makeAsk({ id: "approval:q", subject: "heal_fix", text }))
			).toBe(text);
		}
		const blockerTitle = {
			at: null,
			kind: "tool-failed" as const,
			source: "messages" as const,
			title: "Read failed",
		};
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						blocker: blockerTitle,
						id: "f",
						runState: "failed",
						updatedAt: at(NOW),
					}),
				]
			)
		);
		expect(actOf(acts, "x").bubble?.text).toBe("Read failed");
	});

	test("identifiers and globs keep their markers in names and bubbles", () => {
		for (const target of ["__init__.py", "a*b*c", "**/*.ts"]) {
			const ask = makeAsk({
				agentId: "x",
				id: "approval:t",
				subject: "tool_call",
				target,
				text: "Can I run `shell.run` now?",
			});
			expect(askBubble(ask)).toBe(`Run ${target}?`);
			expect(askAriaLabel(ask, "X", NOW)).toContain(`Target: ${target}.`);
		}
		expect(shortLine("Ship **now** please")).toBe("Ship now please");
	});

	test("countdowns round up whole hours and days", () => {
		expect(
			waitLabel(null, NOW, {
				long: true,
				until: at(NOW + 119 * MINUTE),
				untilApprox: true,
			})
		).toBe("within 2 hours");
		expect(waitLabel(null, NOW, { until: at(NOW + 25 * HOUR) })).toBe("in 2d");
		expect(
			waitLabel(null, NOW, { until: at(NOW + 23 * HOUR + 30 * MINUTE) })
		).toBe("in 1d");
		expect(waitLabel(at(NOW - 119 * MINUTE), NOW, { long: true })).toBe(
			"1 hour"
		);
	});

	test("a likely blocker keeps an acronym's capitals", () => {
		expect(
			blockerAriaLabel(
				{
					at: null,
					kind: "rate-limited",
					source: "estimate",
					title: "API key expired",
				},
				"X",
				NOW
			)
		).toBe("X stopped, likely API key expired.");
	});

	test("redacted ask names say the kind once", () => {
		const fixture = usefulStateFixture({ privacy: "redacted" });
		expect(
			askAriaLabel(
				askOf(fixture, FIXTURE_ASK_IDS.guReply),
				"Gu",
				NOW,
				"redacted"
			)
		).toBe("Gu has an answer ready. Waiting 40 minutes.");
		expect(
			askAriaLabel(
				askOf(fixture, FIXTURE_ASK_IDS.haHeal),
				"Ha",
				NOW,
				"redacted"
			)
		).toBe("Ha has a suggestion. Waiting 2 hours.");
	});

	test("helpers are named only while some run", () => {
		const acts = actsOf(
			miniSnapshot(
				["x"],
				[
					thread({
						agentIds: ["x"],
						helpers: { done: 1, failed: 1, running: 0, titles: [] },
						id: "t",
						updatedAt: at(NOW),
					}),
				]
			)
		);
		expect(actOf(acts, "x").ariaLabel).toBe("X is idle.");
	});

	test("a shared running thread keeps every member working; a stopped one counts once", () => {
		const own = thread({
			agentIds: ["a"],
			id: "own-a",
			running: true,
			updatedAt: at(NOW),
		});
		const team = thread({
			agentIds: ["a", "b"],
			id: "team",
			running: true,
			updatedAt: at(NOW - MINUTE),
		});
		const snap = miniSnapshot(["a", "b"], [own, team]);
		snap.agents = snap.agents.map((agent) => ({ ...agent, status: "working" }));
		const acts = actsOf(snap);
		expect(actOf(acts, "a").act).toBe("working");
		expect(actOf(acts, "b")).toMatchObject({
			act: "working",
			threadId: "team",
		});
		expect(actOf(acts, "b").ariaLabel).toBe("B is working on team.");
		const failed = thread({
			agentIds: ["a", "b"],
			blocker: {
				at: at(NOW - MINUTE),
				kind: "error",
				source: "messages",
				title: "Broke",
			},
			id: "team",
			runState: "failed",
			updatedAt: at(NOW - MINUTE),
		});
		const stopped = actsOf(miniSnapshot(["a", "b"], [own, failed]));
		expect(actOf(stopped, "a")).toMatchObject({ act: "working" });
		expect(actOf(stopped, "a").pending.blocked).toBe(1);
		expect(actOf(stopped, "b")).toMatchObject({
			act: "idle",
			blockers: [],
			threadId: "team",
		});
	});
});
