// Unit tests for the sidebar data layer (sidebar/data.ts) — loadSidebarData fans
// out to six Core endpoints, maps each to the uniform SidebarItem shape, and
// buckets conversations into projects / chats / pinned / archived with a
// YYYY-MM-DD "updated" badge. The load-bearing logic is bucketConversations (folder
// grouping, flag buckets, archived-wins precedence), the convBadge epoch/ISO
// normaliser, and `settled` degradation (one source failing empties only its
// section). All six sources ultimately fetch, so the tests swap globalThis.fetch
// for a URL-routed real-Response server (restored in afterEach) — no Core node, no
// mock.module (which leaks across files in bun's shared process).

import { afterEach, expect, test } from "bun:test";
import type { ApiTarget } from "@ryuhq/core-client/client";
import { emptySidebarData, loadSidebarData } from "../sidebar/data.ts";

const target: ApiTarget = { url: "http://node:7980", token: "tok" };
const realFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = realFetch;
});

interface RouteOverrides {
	agents?: unknown;
	conversations?: unknown;
	meetings?: unknown;
	spaces?: unknown;
	teams?: unknown;
	workflows?: unknown;
	/** Endpoints (by key) that should answer 500 instead of their payload. */
	fail?: string[];
}

const DEFAULTS: Record<string, unknown> = {
	agents: { agents: [] },
	teams: { teams: [] },
	spaces: { spaces: [] },
	meetings: { meetings: [] },
	workflows: { workflows: [] },
	conversations: [],
};

// Route by pathname so bare `/workflows` and `/api/conversations` never collide.
function routeKey(pathname: string): string {
	if (pathname.endsWith("/workflows")) {
		return "workflows";
	}
	if (pathname.endsWith("/api/conversations")) {
		return "conversations";
	}
	if (pathname.endsWith("/api/agents")) {
		return "agents";
	}
	if (pathname.endsWith("/api/teams")) {
		return "teams";
	}
	if (pathname.endsWith("/api/spaces")) {
		return "spaces";
	}
	if (pathname.endsWith("/api/meetings")) {
		return "meetings";
	}
	return "unknown";
}

function server(overrides: RouteOverrides = {}): void {
	const fail = new Set(overrides.fail ?? []);
	globalThis.fetch = ((url: string | URL) => {
		const key = routeKey(new URL(String(url)).pathname);
		if (fail.has(key)) {
			return Promise.resolve(new Response("err", { status: 500 }));
		}
		const payload =
			key in overrides
				? (overrides as Record<string, unknown>)[key]
				: DEFAULTS[key];
		return Promise.resolve(
			new Response(JSON.stringify(payload ?? {}), { status: 200 })
		);
	}) as unknown as typeof fetch;
}

// ── typed-source mapping ─────────────────────────────────────────────────────

test("maps each typed source to its SidebarItem shape (id/label/path/badge)", async () => {
	server({
		agents: { agents: [{ id: "ag1", name: "Researcher" }] },
		teams: { teams: [{ id: "tm1", name: "Ops" }] },
		spaces: { spaces: [{ id: "sp1", name: "Docs", document_count: 12 }] },
		meetings: { meetings: [{ id: "mt1", title: "Standup" }] },
		workflows: { workflows: [{ id: "wf1", name: "Nightly" }] },
	});
	const data = await loadSidebarData(target);

	expect(data.agents).toEqual([
		{ id: "ag1", label: "Researcher", path: "/agents" },
	]);
	expect(data.teams).toEqual([{ id: "tm1", label: "Ops", path: "/teams" }]);
	expect(data.spaces).toEqual([
		{ id: "sp1", label: "Docs", path: "/spaces", badge: "12" },
	]);
	expect(data.meetings).toEqual([
		{ id: "mt1", label: "Standup", path: "/meetings" },
	]);
	expect(data.workflows).toEqual([
		{ id: "wf1", label: "Nightly", path: "/workflows" },
	]);
});

test("a space with no document_count omits the badge", async () => {
	server({ spaces: { spaces: [{ id: "sp2", name: "Empty" }] } });
	const data = await loadSidebarData(target);
	expect(data.spaces[0].badge).toBeUndefined();
});

// ── conversation bucketing ───────────────────────────────────────────────────

test("groups conversations into projects, folderless chats, pinned, archived", async () => {
	server({
		conversations: [
			{ id: "c1", title: "Alpha", folder: "Work" },
			{ id: "c2", title: "Beta", project: "Work" },
			{ id: "c3", title: "Gamma" },
			{ id: "c4", title: "Pinned note", pinned: true },
			{ id: "c5", title: "Old", archived: true },
		],
	});
	const data = await loadSidebarData(target);

	// c1 (folder) + c2 (project) collapse into the one "Work" project group.
	expect(data.projects).toHaveLength(1);
	expect(data.projects[0].name).toBe("Work");
	expect(data.projects[0].chats.map((c) => c.id)).toEqual(["c1", "c2"]);

	// c3 is folderless → chats. c4 is pinned+folderless → BOTH pinned and chats.
	expect(data.chats.map((c) => c.id)).toEqual(["c3", "c4"]);
	expect(data.pinned.map((c) => c.id)).toEqual(["c4"]);

	// c5 archived → archived only (archived wins, skips pinned/folder/chats).
	expect(data.archived.map((c) => c.id)).toEqual(["c5"]);
});

test("an archived conversation is excluded from pinned even when both flags are set", async () => {
	server({
		conversations: [
			{ id: "c9", title: "Both", pinned: true, archived: true, folder: "X" },
		],
	});
	const data = await loadSidebarData(target);
	expect(data.archived.map((c) => c.id)).toEqual(["c9"]);
	expect(data.pinned).toEqual([]);
	expect(data.projects).toEqual([]);
	expect(data.chats).toEqual([]);
});

test("a blank/whitespace title degrades to 'untitled'", async () => {
	server({
		conversations: [
			{ id: "c1", title: "   " },
			{ id: "c2", title: null },
			{ id: "c3" },
		],
	});
	const data = await loadSidebarData(target);
	expect(data.chats.map((c) => c.label)).toEqual([
		"untitled",
		"untitled",
		"untitled",
	]);
});

test("reads a wrapped { conversations: [...] } envelope as well as a bare array", async () => {
	server({ conversations: { conversations: [{ id: "w1", title: "Wrapped" }] } });
	const data = await loadSidebarData(target);
	expect(data.chats.map((c) => c.id)).toEqual(["w1"]);
});

// ── convBadge normalisation ──────────────────────────────────────────────────

test("normalises an epoch-millisecond updated_at into a YYYY-MM-DD badge", async () => {
	// 2021-06-15T12:00:00Z.
	const epoch = Date.UTC(2021, 5, 15, 12, 0, 0);
	server({ conversations: [{ id: "c1", title: "Dated", updated_at: epoch }] });
	const data = await loadSidebarData(target);
	expect(data.chats[0].badge).toBe("2021-06-15");
});

test("normalises an ISO-string updated_at by taking the date part", async () => {
	server({
		conversations: [
			{ id: "c1", title: "Iso", updated_at: "2020-01-02T09:30:00Z" },
		],
	});
	const data = await loadSidebarData(target);
	expect(data.chats[0].badge).toBe("2020-01-02");
});

test("ignores a non-date updated_at (empty string / unexpected type)", async () => {
	server({
		conversations: [
			{ id: "c1", title: "A", updated_at: "" },
			{ id: "c2", title: "B", updated_at: null },
			{ id: "c3", title: "C" },
		],
	});
	const data = await loadSidebarData(target);
	expect(data.chats.every((c) => c.badge === undefined)).toBe(true);
});

// REGRESSION: a finite but out-of-range epoch (> ±8.64e15 ms, the max Date value)
// makes new Date(raw).toISOString() throw RangeError. bucketConversations runs
// OUTSIDE `settled`, so before the range guard this rejected the whole
// loadSidebarData. Pin that it degrades to "no badge" and the load still resolves.
test("an out-of-range epoch does not crash the whole sidebar load", async () => {
	server({
		conversations: [
			{ id: "c1", title: "Sane", updated_at: Date.UTC(2022, 0, 1) },
			{ id: "c2", title: "Insane", updated_at: 1e16 },
		],
	});
	const data = await loadSidebarData(target);
	// The load resolved (did not reject) and the sane row kept its badge.
	expect(data.chats.map((c) => c.id)).toEqual(["c1", "c2"]);
	expect(data.chats[0].badge).toBe("2022-01-01");
	expect(data.chats[1].badge).toBeUndefined();
});

// ── graceful degradation ─────────────────────────────────────────────────────

test("a single source failing empties only its section, not the whole load", async () => {
	server({
		agents: { agents: [{ id: "ag1", name: "A" }] },
		conversations: [{ id: "c1", title: "Chat" }],
		fail: ["teams"],
	});
	const data = await loadSidebarData(target);
	// teams degraded to empty…
	expect(data.teams).toEqual([]);
	// …while the healthy sources still loaded.
	expect(data.agents).toHaveLength(1);
	expect(data.chats).toHaveLength(1);
});

test("all sources failing yields the empty sidebar shape (no throw)", async () => {
	server({
		fail: ["agents", "teams", "spaces", "meetings", "workflows", "conversations"],
	});
	const data = await loadSidebarData(target);
	expect(data).toEqual(emptySidebarData);
});
