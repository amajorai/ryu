// The TUI layout file: same versioned format as Desktop, owner-only on disk,
// replaced atomically, and never fatal. Every case uses a temporary directory;
// nothing reads or writes a real Ryu profile.

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reduceWorkbench } from "@ryu/workbench/reducer";
import { initialWorkbench } from "../workspace/WorkspaceContext.tsx";
import {
	fileWorkbenchPersistence,
	loadWorkbenchLayout,
	saveWorkbenchLayout,
} from "../workspace/workbenchPersistence.ts";

let directory = "";

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "ryu-tui-layout-"));
});

afterEach(() => {
	rmSync(directory, { force: true, recursive: true });
});

function layoutWithBottomTab() {
	const state = initialWorkbench();
	const bottom = state.groups.find((group) => group.region === "bottom");
	if (!bottom) {
		throw new Error("missing Bottom group");
	}
	return reduceWorkbench(state, {
		type: "item/open",
		groupId: bottom.id,
		item: {
			closable: true,
			duplicable: false,
			id: "agents-tab",
			pinned: false,
			preferredRegion: "center",
			scope: { kind: "window" },
			source: { kind: "route", path: "/agents" },
			title: "Agents",
		},
	});
}

test("saves owner-only and reloads tab placement and visible regions", () => {
	const path = join(directory, "nested", "workbench-layout.json");
	const state = layoutWithBottomTab();
	expect(saveWorkbenchLayout(state, path)).toEqual({ ok: true });
	expect(statSync(path).mode & 0o777).toBe(0o600);
	expect(readdirSync(join(directory, "nested"))).toEqual([
		"workbench-layout.json",
	]);

	const loaded = loadWorkbenchLayout(path);
	const bottom = loaded?.groups.find((group) => group.region === "bottom");
	expect(bottom?.itemIds).toEqual(["agents-tab"]);
	expect(loaded?.openRegions.bottom).toBe(true);
	expect(loaded?.closedItems).toEqual([]);
});

test("falls back to no layout for a missing or corrupt file", () => {
	const path = join(directory, "workbench-layout.json");
	expect(loadWorkbenchLayout(path)).toBeUndefined();
	writeFileSync(path, "{ not json");
	expect(loadWorkbenchLayout(path)).toBeUndefined();
	writeFileSync(path, JSON.stringify({ version: 1 }));
	expect(loadWorkbenchLayout(path)).toBeUndefined();
});

test("reports a failed save once per run of failures without throwing", () => {
	const blocker = join(directory, "not-a-directory");
	writeFileSync(blocker, "");
	const errors: string[] = [];
	const persistence = fileWorkbenchPersistence({
		onError: (message) => errors.push(message),
		path: join(blocker, "workbench-layout.json"),
	});
	const state = initialWorkbench();
	expect(persistence.save(state)).toEqual({
		message: "Layout could not be saved.",
		ok: false,
	});
	persistence.save(state);
	expect(errors).toEqual(["Layout could not be saved."]);
	expect(existsSync(join(blocker, "workbench-layout.json"))).toBe(false);
});
