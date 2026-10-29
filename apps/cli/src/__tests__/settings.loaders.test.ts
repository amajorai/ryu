// Unit tests for the Settings overlay's read-only panel loaders
// (overlays/settings/loaders.ts). Each loader maps one Core read endpoint to
// ListRow[]; the tests serve canned JSON through the target's own `fetch` so no
// node is contacted and no global swap leaks into the shared-process suites.

import { expect, test } from "bun:test";
import type { appRequestValueSchema } from "@ryuhq/core-client/app-request-json";
import type { ApiTarget } from "@ryuhq/core-client/client";
import type { z } from "zod";
import {
	formatBytes,
	loadDataCounts,
	loadFeatures,
	loadMeetings,
	loadMemory,
	loadPrivacy,
	loadQuests,
	loadStorage,
	oneLine,
	PRIVACY_PREFS,
} from "../overlays/settings/loaders.ts";

interface FixtureResponseRoute {
	body: z.infer<typeof appRequestValueSchema>;
	status?: ResponseInit["status"];
}
interface Routes {
	[path: string]: FixtureResponseRoute;
}

function targetFor(routes: Routes, seen: string[] = []): ApiTarget {
	const fetchImpl: NonNullable<ApiTarget["fetch"]> = (input) => {
		const url = new URL(String(input));
		const key = `${url.pathname}${url.search}`;
		seen.push(key);
		const route = routes[key] ?? routes[url.pathname];
		if (!route) {
			return Promise.resolve(new Response("{}", { status: 404 }));
		}
		return Promise.resolve(
			new Response(JSON.stringify(route.body), { status: route.status ?? 200 })
		);
	};
	return {
		url: "http://node:7980",
		token: "tok",
		fetch: fetchImpl,
	};
}

test("oneLine flattens whitespace and truncates", () => {
	expect(oneLine("  a\n\tb  ")).toBe("a b");
	expect(oneLine("abcdef", 4)).toBe("abc…");
});

test("formatBytes uses binary units", () => {
	expect(formatBytes(512)).toBe("512 B");
	expect(formatBytes(1536)).toBe("1.5 KB");
	expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
	expect(formatBytes(-1)).toBe("unknown");
});

test("loadMemory maps entries with scope and importance", async () => {
	const seen: string[] = [];
	const rows = await loadMemory(
		targetFor(
			{
				"/api/memory": {
					body: {
						memories: [
							{
								id: "m1",
								content: "Prefers\ndark mode",
								scope: "project",
								scope_id: "/src/app",
								category: "preference",
								importance: 4,
							},
							{ id: "m2", content: "Lives in Singapore" },
						],
					},
				},
			},
			seen
		)
	);
	expect(seen).toEqual(["/api/memory?limit=200"]);
	expect(rows).toEqual([
		{
			id: "m1",
			title: "Prefers dark mode",
			subtitle: "project:/src/app · importance 4",
			badge: "preference",
		},
		{
			id: "m2",
			title: "Lives in Singapore",
			subtitle: "user",
			badge: undefined,
		},
	]);
});

test("loadMeetings shows date, participants and status", async () => {
	const rows = await loadMeetings(
		targetFor({
			"/api/meetings": {
				body: {
					meetings: [
						{
							id: "mt1",
							title: "Weekly sync",
							created_at: "2026-09-01T10:00:00Z",
							started_at: "2026-09-02T10:00:00Z",
							participants: ["a", "b"],
							app: "Zoom",
							status: "done",
							source: "manual",
							updated_at: "2026-09-02T10:00:00Z",
						},
					],
				},
			},
		})
	);
	expect(rows).toEqual([
		{
			id: "mt1",
			title: "Weekly sync",
			subtitle: "2026-09-02 · 2 participants · Zoom",
			badge: "done",
		},
	]);
});

test("loadQuests shows kind, condition and pinned status", async () => {
	const rows = await loadQuests(
		targetFor({
			"/api/quests": {
				body: {
					quests: [
						{
							id: "q1",
							title: "Ship release",
							completion_condition: "tag is pushed",
							status: "open",
							pinned: true,
							created_at: "2026-09-01T10:00:00Z",
							updated_at: "2026-09-01T10:00:00Z",
						},
						{
							id: "q2",
							title: "Keep link",
							kind: "link",
							completion_condition: "",
							status: "done",
							created_at: "2026-09-01T10:00:00Z",
							updated_at: "2026-09-01T10:00:00Z",
						},
					],
				},
			},
		})
	);
	expect(rows).toEqual([
		{
			id: "q1",
			title: "Ship release",
			subtitle: "task · tag is pushed",
			badge: "open · pinned",
		},
		{ id: "q2", title: "Keep link", subtitle: "link", badge: "done" },
	]);
});

test("loadFeatures labels install and enable state", async () => {
	const rows = await loadFeatures(
		targetFor({
			"/api/plugins": {
				body: {
					apps: [
						{
							id: "com.ryu.meetings",
							name: "Meetings",
							version: "1.0.0",
							installed: true,
							installed_version: "1.0.0",
							enabled: true,
							permission_grants: [],
							runnables: [],
							built_in: false,
							local_only: false,
							sidecar_name: null,
							windows_first: false,
						},
						{
							id: "com.ryu.browser",
							name: "Browser",
							version: "0.2.0",
							installed: true,
							installed_version: null,
							enabled: false,
							permission_grants: [],
							runnables: [],
							built_in: false,
							local_only: false,
							sidecar_name: null,
							windows_first: false,
						},
						{
							id: "com.ryu.finetune",
							name: "Fine-tune",
							version: "0.1.0",
							installed: false,
							installed_version: null,
							enabled: false,
							permission_grants: [],
							runnables: [],
							built_in: false,
							local_only: false,
							sidecar_name: null,
							windows_first: false,
						},
					],
				},
			},
		})
	);
	expect(rows.map((row) => [row.title, row.badge])).toEqual([
		["Meetings", "enabled"],
		["Browser", "disabled"],
		["Fine-tune", "not installed"],
	]);
	expect(rows[0]?.subtitle).toBe("com.ryu.meetings · v1.0.0");
});

test("loadStorage reports folder, usage and free space", async () => {
	const rows = await loadStorage(
		targetFor({
			"/api/data-path": {
				body: {
					current: "/data/ryu",
					default: "/home/u/.ryu",
					is_custom: true,
					size_bytes: 2048,
					free_space_bytes: 1024 ** 3,
				},
			},
		})
	);
	expect(rows).toEqual([
		{
			id: "current",
			title: "Data folder",
			subtitle: "/data/ryu",
			badge: "custom",
		},
		{ id: "size", title: "Used", badge: "2.0 KB" },
		{ id: "free", title: "Free on disk", badge: "1.0 GB" },
		{ id: "default", title: "Default folder", subtitle: "/home/u/.ryu" },
	]);
});

test("loadDataCounts maps category descriptors", async () => {
	const rows = await loadDataCounts(
		targetFor({
			"/api/data/counts": {
				body: {
					chats: 3,
					categories: [
						{
							id: "chats",
							title: "Delete all chats",
							noun: "chats",
							detail: "Removes every conversation.",
							count: 3,
							confirm_word: "chats",
							plugin: null,
						},
						{
							id: "memory",
							title: "Delete memory",
							count: 0,
							/* Complete wire-domain fallback case: empty noun/detail intentionally differ from current registry descriptors. */ noun: "",
							detail: "",
							confirm_word: "memory",
							plugin: null,
						},
					],
					spaces: 0,
					memory: 0,
					monitors: 0,
					meetings: 0,
				},
			},
		})
	);
	expect(rows).toEqual([
		{
			id: "chats",
			title: "Delete all chats",
			subtitle: "Removes every conversation.",
			badge: "3 chats",
		},
		{ id: "memory", title: "Delete memory", subtitle: undefined, badge: "0" },
	]);
});

test("loadPrivacy reads each canonical key and labels defaults", async () => {
	const routes: Routes = {
		"/api/preferences/product-analytics-enabled": {
			body: { key: "product-analytics-enabled", value: "false" },
		},
		"/api/preferences/crash-reports-enabled": {
			body: { key: "crash-reports-enabled", value: null },
		},
		"/api/preferences/community-stats-enabled": {
			body: { key: "community-stats-enabled", value: "true" },
		},
		"/api/preferences/profile-activity-enabled": {
			body: { key: "profile-activity-enabled", value: null },
		},
		"/api/preferences/diagnostics-export-enabled": {
			body: { key: "diagnostics-export-enabled", value: null },
		},
		// support-access-local-enabled is deliberately unrouted (404).
	};
	const rows = await loadPrivacy(targetFor(routes));
	expect(rows.map((row) => row.id)).toEqual(PRIVACY_PREFS.map((p) => p.key));
	expect(rows.map((row) => row.badge)).toEqual([
		"off",
		"on (default)",
		"on",
		"on (default)",
		"off (default)",
		"unavailable",
	]);
});

test("a failing endpoint rejects so ListTab can show the error", async () => {
	await expect(
		loadMemory(targetFor({ "/api/memory": { body: {}, status: 500 } }))
	).rejects.toThrow();
});
