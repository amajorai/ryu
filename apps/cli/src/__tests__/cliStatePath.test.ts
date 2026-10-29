import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cliDataDir, cliUserHome } from "../core/cliStatePath.ts";
import {
	layoutPreferencePath,
	readLayoutPreference,
	writeLayoutPreference,
} from "../core/layoutPreferences.ts";
import {
	memoryConsentPath,
	readMemoryConsent,
	writeMemoryConsent,
} from "../core/memoryConsent.ts";
import { loadNodes, nodesPath, setActive } from "../core/nodes.ts";
import {
	defaultProductModePreference,
	productModePreferencePath,
	readProductModePreference,
	withProductMode,
	writeProductModePreference,
} from "../core/productMode.ts";
import {
	loadPromptHistory,
	promptHistoryPath,
	savePromptHistory,
} from "../core/promptHistory.ts";

const keys = ["RYU_CLI_CONFIG_DIR", "RYU_DIR"] as const;
function isolated(run: (directory: string) => void) {
	const previous = Object.fromEntries(
		keys.map((key) => [key, process.env[key]])
	);
	const directory = mkdtempSync(join(tmpdir(), "ryu-cli-state-path-"));
	try {
		run(directory);
	} finally {
		for (const key of keys) {
			if (previous[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = previous[key];
			}
		}
		rmSync(directory, { recursive: true, force: true });
	}
}
test("opt-in CLI root persists and reopens all five files without altering home or Core defaults", () =>
	isolated((directory) => {
		const selected = join(directory, "selected");
		const core = join(directory, "core");
		const originalHome = process.env.HOME;
		const originalUserProfile = process.env.USERPROFILE;
		process.env.RYU_CLI_CONFIG_DIR = selected;
		process.env.RYU_DIR = core;
		// Canary at the Core-default location (#640 layout) that the opt-in root
		// must leave untouched.
		const coreMemory = join(core, "state", "cli", "cli-memory.json");
		mkdirSync(dirname(coreMemory), { recursive: true });
		mkdirSync(selected, { recursive: true });
		writeFileSync(coreMemory, '{"version":1,"enableLongTerm":false}');
		const config = {
			default: "first",
			nodes: [
				{ name: "first", url: "http://127.0.0.1:2049", token: null },
				{
					name: "second",
					url: "http://127.0.0.1:2050",
					token: "local-fixture-token",
				},
			],
		};
		writeFileSync(nodesPath(), JSON.stringify(config));
		setActive("second");
		expect(loadNodes()).toEqual({ ...config, default: "second" });
		const preference = withProductMode(
			defaultProductModePreference(),
			"console",
			"/home"
		);
		writeProductModePreference(preference);
		expect(readProductModePreference()).toEqual(preference);
		savePromptHistory(["first prompt", "second prompt"]);
		expect(loadPromptHistory().entries).toEqual([
			"first prompt",
			"second prompt",
		]);
		writeMemoryConsent(true);
		expect(readMemoryConsent()).toBe(true);
		writeLayoutPreference({ sidebar: "hidden" });
		expect(readLayoutPreference()).toEqual({ sidebar: "hidden" });
		expect([
			nodesPath(),
			productModePreferencePath(),
			promptHistoryPath(),
			memoryConsentPath(),
			layoutPreferencePath(),
		]).toEqual(
			[
				"nodes.json",
				"cli-product-mode.json",
				"prompt-history.json",
				"cli-memory.json",
				"cli-layout.json",
			].map((file) => join(selected, file))
		);
		expect(process.env.RYU_DIR).toBe(core);
		expect(process.env.HOME).toBe(originalHome);
		expect(process.env.USERPROFILE).toBe(originalUserProfile);
		expect(readFileSync(coreMemory, "utf8")).toBe(
			'{"version":1,"enableLongTerm":false}'
		);
	}));
test("unset override resolves every file in Core's data-dir layout with RYU_DIR, USERPROFILE, then HOME precedence", () =>
	isolated((directory) => {
		const fakeEnv = {
			HOME: join(directory, "home"),
			USERPROFILE: join(directory, "profile"),
			RYU_DIR: join(directory, "core"),
		};
		// RYU_DIR relocates the whole data dir, a `home` override included.
		expect(nodesPath(fakeEnv)).toBe(
			join(fakeEnv.RYU_DIR, "state", "nodes.json")
		);
		expect(promptHistoryPath(fakeEnv)).toBe(
			join(fakeEnv.RYU_DIR, "state", "cli", "prompt-history.json")
		);
		expect(layoutPreferencePath(fakeEnv)).toBe(
			join(fakeEnv.RYU_DIR, "state", "cli", "cli-layout.json")
		);
		expect(productModePreferencePath(undefined, fakeEnv)).toBe(
			join(fakeEnv.RYU_DIR, "state", "cli", "cli-product-mode.json")
		);
		expect(productModePreferencePath(directory, fakeEnv)).toBe(
			join(fakeEnv.RYU_DIR, "state", "cli", "cli-product-mode.json")
		);
		expect(memoryConsentPath(fakeEnv)).toBe(
			join(fakeEnv.RYU_DIR, "state", "cli", "cli-memory.json")
		);
		const profileEnv = { HOME: fakeEnv.HOME, USERPROFILE: fakeEnv.USERPROFILE };
		expect(nodesPath(profileEnv)).toBe(
			join(fakeEnv.USERPROFILE, ".ryu", "state", "nodes.json")
		);
		expect(promptHistoryPath(profileEnv)).toBe(
			join(fakeEnv.USERPROFILE, ".ryu", "state", "cli", "prompt-history.json")
		);
		expect(layoutPreferencePath(profileEnv)).toBe(
			join(fakeEnv.USERPROFILE, ".ryu", "state", "cli", "cli-layout.json")
		);
		expect(productModePreferencePath(undefined, profileEnv)).toBe(
			join(fakeEnv.USERPROFILE, ".ryu", "state", "cli", "cli-product-mode.json")
		);
		expect(productModePreferencePath(directory, profileEnv)).toBe(
			join(directory, ".ryu", "state", "cli", "cli-product-mode.json")
		);
		expect(memoryConsentPath(profileEnv)).toBe(
			join(fakeEnv.USERPROFILE, ".ryu", "state", "cli", "cli-memory.json")
		);
		const emptyProfile = { HOME: fakeEnv.HOME, USERPROFILE: "" };
		expect(nodesPath(emptyProfile)).toBe(
			join(fakeEnv.HOME, ".ryu", "state", "nodes.json")
		);
		expect(promptHistoryPath(emptyProfile)).toBe(
			join(fakeEnv.HOME, ".ryu", "state", "cli", "prompt-history.json")
		);
		expect(layoutPreferencePath(emptyProfile)).toBe(
			join(fakeEnv.HOME, ".ryu", "state", "cli", "cli-layout.json")
		);
		expect(productModePreferencePath(undefined, emptyProfile)).toBe(
			join(fakeEnv.HOME, ".ryu", "state", "cli", "cli-product-mode.json")
		);
		expect(memoryConsentPath(emptyProfile)).toBe(
			join(fakeEnv.HOME, ".ryu", "state", "cli", "cli-memory.json")
		);
		// The profile picks the data dir's suffix, exactly like Core.
		const devProfile = { HOME: fakeEnv.HOME, RYU_PROFILE: "dev" };
		expect(nodesPath(devProfile)).toBe(
			join(fakeEnv.HOME, ".ryu-dev", "state", "nodes.json")
		);
		expect(memoryConsentPath(devProfile)).toBe(
			join(fakeEnv.HOME, ".ryu-dev", "state", "cli", "cli-memory.json")
		);
		// With no home variables at all, the OS home anchors the data dir.
		expect(cliUserHome({})).toBe(homedir());
		const fallbackRoot = cliDataDir({});
		expect(nodesPath({})).toBe(join(fallbackRoot, "state", "nodes.json"));
		expect(promptHistoryPath({})).toBe(
			join(fallbackRoot, "state", "cli", "prompt-history.json")
		);
		expect(productModePreferencePath(undefined, {})).toBe(
			join(fallbackRoot, "state", "cli", "cli-product-mode.json")
		);
		expect(memoryConsentPath({})).toBe(
			join(fallbackRoot, "state", "cli", "cli-memory.json")
		);
	}));
test("invalid explicit roots fail clearly before read defaults or best-effort writes can hide them", () =>
	isolated(() => {
		for (const value of ["", "relative", "./state", " ", "/invalid\0root"]) {
			process.env.RYU_CLI_CONFIG_DIR = value;
			for (const operation of [
				nodesPath,
				productModePreferencePath,
				promptHistoryPath,
				memoryConsentPath,
				layoutPreferencePath,
				loadNodes,
				readProductModePreference,
				loadPromptHistory,
				readMemoryConsent,
				() => savePromptHistory(["must not save"]),
				() => writeMemoryConsent(true),
			]) {
				expect(operation).toThrow(
					"RYU_CLI_CONFIG_DIR must be an absolute directory path."
				);
			}
		}
	}));
