import { describe, expect, it } from "bun:test";
import { promptEditCacheWarning } from "@ryu/blocks/desktop/agent-elements/prompt-cache.ts";
import {
	bundleSkillChanges,
	enabledSkillUpdates,
	skillDisplayName,
	skillSetChangeLabels,
	skillsNotInstalled,
	skillToggleChangesSet,
	skillUpdateChanges,
} from "./skill-set-change.ts";

describe("skillDisplayName", () => {
	it("prefers the catalog name", () => {
		expect(skillDisplayName("owner/repo/demo", " Demo ")).toBe("Demo");
	});

	it("falls back to the id's last segment", () => {
		expect(skillDisplayName("owner/repo/demo")).toBe("demo");
		expect(skillDisplayName("demo", "  ")).toBe("demo");
	});
});

describe("skillSetChangeLabels", () => {
	it("returns nothing when no skill changes, so no confirm shows", () => {
		expect(skillSetChangeLabels([])).toEqual([]);
		expect(skillSetChangeLabels([" ", ""])).toEqual([]);
		expect(
			promptEditCacheWarning(skillSetChangeLabels([]), "skill-threads")
		).toBeNull();
	});

	it("names a single skill", () => {
		const labels = skillSetChangeLabels(["Alpha"]);
		expect(labels).toEqual(["The Alpha skill"]);
		expect(
			promptEditCacheWarning(labels, "skill-threads")?.description
		).toStartWith(
			"The Alpha skill is part of the system prompt for every thread that loads skills."
		);
	});

	it("lists a few skills and summarises the rest", () => {
		expect(skillSetChangeLabels(["A", "B", "A"])).toEqual(["A", "B"]);
		expect(skillSetChangeLabels(["A", "B", "C", "D"])).toEqual([
			"A",
			"B",
			"C",
			"D",
		]);
		expect(skillSetChangeLabels(["A", "B", "C", "D", "E"])).toEqual([
			"A",
			"B",
			"C",
			"2 more skills",
		]);
	});
});

describe("skillToggleChangesSet", () => {
	it("is false for a no-op and true for a real or unknown change", () => {
		expect(skillToggleChangesSet(true, true)).toBe(false);
		expect(skillToggleChangesSet(false, false)).toBe(false);
		expect(skillToggleChangesSet(true, false)).toBe(true);
		expect(skillToggleChangesSet(undefined, true)).toBe(true);
	});
});

describe("skillsNotInstalled", () => {
	it("names only candidates whose id or slug is not installed", () => {
		expect(
			skillsNotInstalled(
				[
					{ id: "owner/repo/alpha", name: "Alpha" },
					{ id: "beta" },
					{ id: "owner/repo/gamma", name: "Gamma" },
				],
				new Set(["alpha", "beta"])
			)
		).toEqual(["Gamma"]);
	});
});

describe("bundleSkillChanges", () => {
	const members = [
		{ id: "owner/repo/alpha", kind: "skill", name: "Alpha" },
		{ id: "owner/repo/gamma", kind: "skill", name: null },
		{ id: "some-plugin", kind: "plugin", name: "Plugin" },
	];

	it("asks nothing for a bundle without skill members", async () => {
		expect(
			await bundleSkillChanges({ url: "http://127.0.0.1:9", token: null }, [
				{ id: "some-plugin", kind: "plugin", name: "Plugin" },
			])
		).toEqual([]);
	});

	it("names only the skill members the node does not have", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				Response.json({
					skills: [{ id: "alpha", name: "Alpha", enabled: true }],
				}),
		});
		try {
			expect(
				await bundleSkillChanges(
					{ url: server.url.origin, token: null },
					members
				)
			).toEqual(["gamma"]);
		} finally {
			await server.stop(true);
		}
	});

	it("names every skill member when the installed list cannot be read", async () => {
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => Response.json({ error: "down" }, { status: 500 }),
		});
		try {
			expect(
				await bundleSkillChanges(
					{ url: server.url.origin, token: null },
					members
				)
			).toEqual(["Alpha", "gamma"]);
		} finally {
			await server.stop(true);
		}
	});
});

describe("enabledSkillUpdates", () => {
	const updates = [
		{ id: "owner/repo/alpha", name: "Alpha", slug: "alpha" },
		{ id: "owner/repo/beta", name: "Beta", slug: "beta" },
		{ id: "owner/repo/gamma", name: null },
	];

	it("names only the updates of enabled skills", () => {
		expect(
			enabledSkillUpdates(updates, [
				{ id: "alpha", enabled: true },
				{ id: "beta", enabled: false },
				{ id: "gamma", enabled: true },
			])
		).toEqual(["Alpha", "gamma"]);
	});

	it("asks nothing when every updated skill is disabled", () => {
		expect(
			enabledSkillUpdates(updates, [
				{ id: "alpha", enabled: false },
				{ id: "beta", enabled: false },
				{ id: "gamma", enabled: false },
			])
		).toEqual([]);
	});

	it("counts a skill missing from the installed list as enabled", () => {
		expect(
			enabledSkillUpdates(updates, [{ id: "beta", enabled: false }])
		).toEqual(["Alpha", "gamma"]);
	});
});

describe("skillUpdateChanges", () => {
	const target = { url: "http://127.0.0.1:9", token: null };

	it("reads nothing when no skill updates", async () => {
		let reads = 0;
		const names = await skillUpdateChanges(target, [], async () => {
			reads += 1;
			return [];
		});
		expect(names).toEqual([]);
		expect(reads).toBe(0);
	});

	it("names every update when the installed list cannot be read", async () => {
		const names = await skillUpdateChanges(
			target,
			[{ id: "owner/repo/alpha", name: "Alpha", slug: "alpha" }],
			async () => {
				throw new Error("offline");
			}
		);
		expect(names).toEqual(["Alpha"]);
	});
});
