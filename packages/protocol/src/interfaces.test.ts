import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	builtinInterfaceId,
	CONTRIBUTABLE_INTERFACE_RENDERERS,
	channelHandle,
	FEED_EXCERPT_LIMIT,
	interfaceTier,
	layoutWorld,
	MAX_CONTRIBUTED_INTERFACES,
	nearestWorldEntity,
	parseInterfaceContribution,
	parseInterfaceContributions,
	projectChannels,
	projectFeed,
	resolveInterfaceParams,
	stepWorldPlayer,
} from "./interfaces.ts";
import {
	RUST_MANIFEST_PATH,
	RUST_SERVER_PATH,
	snapshot,
	thread,
} from "./interfaces-test-fixtures.ts";

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
				"apps/core/src/server/app_lifecycle/plugin_collect.rs no longer contains MAX_PLUGIN_INTERFACE_ROWS_PER_RESPONSE — anchor lost"
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
