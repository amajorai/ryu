import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// Pin the CLI's language before any module computes it: `CLI_LOCALE` is read once
// at import time from RYU_LOCALE > LC_ALL > LC_MESSAGES > LANG, so a developer's
// German or Japanese shell must not change the English copy tests assert on.
// Static imports are hoisted above this assignment, so CLI modules load below.
process.env.RYU_LOCALE = "en";
const { productModePreferencePath } = await import("../core/productMode.ts");

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
// The data-dir resolver honours RYU_DIR and the Storage pointer before HOME; a
// test must never resolve (and write into) the caller's real data dir.
const originalRyuDir = process.env.RYU_DIR;
const originalConfigHome = process.env.XDG_CONFIG_HOME;
const originalAppData = process.env.APPDATA;

function restore(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
	} else {
		process.env[key] = value;
	}
}
const temporaryHomes = new Set<string>();
let activeHome: string | null = null;

function removeTemporaryHomes(): void {
	for (const home of temporaryHomes) {
		rmSync(home, { force: true, recursive: true });
	}
	temporaryHomes.clear();
}

beforeEach(() => {
	activeHome = mkdtempSync(join(tmpdir(), "ryu-cli-test-home-"));
	temporaryHomes.add(activeHome);
	process.env.HOME = activeHome;
	process.env.USERPROFILE = activeHome;
	delete process.env.RYU_DIR;
	process.env.XDG_CONFIG_HOME = join(activeHome, ".config");
	process.env.APPDATA = join(activeHome, ".config");
	const preferenceFile = productModePreferencePath(activeHome);
	mkdirSync(dirname(preferenceFile), { recursive: true });
	writeFileSync(
		preferenceFile,
		`${JSON.stringify(
			{
				mode: "console",
				surfaces: {
					bot: "/chat",
					console: "/chat",
					os: "/app-launcher",
				},
				version: 1,
			},
			null,
			2
		)}\n`
	);
});

afterEach(() => {
	if (activeHome) {
		rmSync(activeHome, { force: true, recursive: true });
		temporaryHomes.delete(activeHome);
		activeHome = null;
	}
	restore("HOME", originalHome);
	restore("USERPROFILE", originalUserProfile);
	restore("RYU_DIR", originalRyuDir);
	restore("XDG_CONFIG_HOME", originalConfigHome);
	restore("APPDATA", originalAppData);
});

process.on("exit", removeTemporaryHomes);
