import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseLayoutPreference,
	readLayoutPreference,
	resolveSidebarVisible,
	SIDEBAR_AUTO_MIN_COLUMNS,
	writeLayoutPreference,
} from "../core/layoutPreferences.ts";

function withDirectory(run: (directory: string) => void): void {
	const directory = mkdtempSync(join(tmpdir(), "ryu-cli-layout-"));
	try {
		run(directory);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

test("auto shows the sidebar from 100 columns; an explicit choice wins", () => {
	expect(SIDEBAR_AUTO_MIN_COLUMNS).toBe(100);
	expect(resolveSidebarVisible("auto", 60)).toBe(false);
	expect(resolveSidebarVisible("auto", 99)).toBe(false);
	expect(resolveSidebarVisible("auto", 100)).toBe(true);
	expect(resolveSidebarVisible("auto", 140)).toBe(true);
	expect(resolveSidebarVisible("shown", 40)).toBe(true);
	expect(resolveSidebarVisible("hidden", 200)).toBe(false);
});

test("a written choice reads back and the file holds only the sidebar field", () =>
	withDirectory((directory) => {
		const path = join(directory, "nested", "cli-layout.json");
		expect(readLayoutPreference(path)).toEqual({ sidebar: "auto" });
		writeLayoutPreference({ sidebar: "hidden" }, path);
		expect(readLayoutPreference(path)).toEqual({ sidebar: "hidden" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			sidebar: "hidden",
		});
	}));

test("corrupt or unknown values fall back to auto", () =>
	withDirectory((directory) => {
		const path = join(directory, "cli-layout.json");
		writeFileSync(path, "{ not json");
		expect(readLayoutPreference(path)).toEqual({ sidebar: "auto" });
		writeFileSync(path, JSON.stringify({ sidebar: "sideways" }));
		expect(readLayoutPreference(path)).toEqual({ sidebar: "auto" });
		expect(parseLayoutPreference(null)).toEqual({ sidebar: "auto" });
		expect(parseLayoutPreference({ sidebar: "shown", extra: 1 })).toEqual({
			sidebar: "shown",
		});
	}));
