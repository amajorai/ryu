import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	historyEntryFor,
	initialPromptHistory,
	loadAndMigratePromptHistory,
	loadSealedPromptHistory,
	mergeLoadedHistory,
	nextPrompt,
	type PromptHistorySealer,
	PromptHistoryUnreadableError,
	previousPrompt,
	recordPrompt,
	resetPromptNavigation,
	saveSealedPromptHistory,
} from "../core/promptHistory.ts";

/** A stand-in for Core's seal/open routes (reversible, clearly not plaintext). */
function fakeSealer(): PromptHistorySealer & { calls: number } {
	const sealer = {
		calls: 0,
		open(sealed: string): Promise<string> {
			sealer.calls += 1;
			if (!sealed.startsWith("encb:v1:")) {
				return Promise.reject(new Error("not sealed"));
			}
			return Promise.resolve(
				Buffer.from(sealed.slice("encb:v1:".length), "base64")
					.toString("utf8")
					.split("")
					.reverse()
					.join("")
			);
		},
		seal(plaintext: string): Promise<string> {
			sealer.calls += 1;
			const reversed = plaintext.split("").reverse().join("");
			return Promise.resolve(
				`encb:v1:${Buffer.from(reversed, "utf8").toString("base64")}`
			);
		},
	};
	return sealer;
}

const unreachableCore: PromptHistorySealer = {
	open: () => Promise.reject(new Error("Core is not running")),
	seal: () => Promise.reject(new Error("Core is not running")),
};

let tempDir = "";

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "ryu-prompt-history-"));
});

afterEach(() => {
	if (existsSync(tempDir)) {
		rmSync(tempDir, { recursive: true, force: true });
	}
});

test("round-trips bounded history sealed and ignores corrupt files", async () => {
	const path = join(tempDir, "nested", "history.json");
	const sealer = fakeSealer();
	let state = initialPromptHistory();
	for (let index = 0; index < 101; index += 1) {
		state = recordPrompt(state, `prompt-${index}`);
	}
	expect(await saveSealedPromptHistory(state.entries, sealer, path)).toBe(true);

	const onDisk = readFileSync(path, "utf8");
	expect(onDisk.startsWith("encb:v1:")).toBe(true);
	expect(onDisk).not.toContain("prompt-1");
	const loaded = await loadSealedPromptHistory(sealer, path);
	expect(loaded.state.entries).toHaveLength(100);
	expect(loaded.state.entries[0]).toBe("prompt-1");
	expect(loaded.legacyPlaintext).toBe(false);

	await Bun.write(path, "not-json");
	expect((await loadSealedPromptHistory(sealer, path)).state.entries).toEqual(
		[]
	);
});

test("migrates a legacy plaintext file only once the sealed copy is confirmed", async () => {
	const path = join(tempDir, "history.json");
	writeFileSync(path, JSON.stringify(["legacy secret prompt"]));

	// Without Core the plaintext still reads, and stays until Core is back.
	expect(
		(await loadAndMigratePromptHistory(unreachableCore, path)).entries
	).toEqual(["legacy secret prompt"]);
	expect(readFileSync(path, "utf8")).toContain("legacy secret prompt");

	const sealer = fakeSealer();
	expect((await loadAndMigratePromptHistory(sealer, path)).entries).toEqual([
		"legacy secret prompt",
	]);
	const sealed = readFileSync(path, "utf8");
	expect(sealed.startsWith("encb:v1:")).toBe(true);
	expect(sealed).not.toContain("legacy secret prompt");
	// Idempotent: a second run reads the sealed file and rewrites nothing.
	expect((await loadAndMigratePromptHistory(sealer, path)).entries).toEqual([
		"legacy secret prompt",
	]);
	expect(readFileSync(path, "utf8")).toBe(sealed);
	// No temporary file is left behind.
	expect(readdirSync(tempDir)).toEqual(["history.json"]);
});

test("keeps history in memory only without a reachable Core", async () => {
	const path = join(tempDir, "memory-only", "history.json");
	expect(await saveSealedPromptHistory(["typed"], null, path)).toBe(false);
	expect(await saveSealedPromptHistory(["typed"], unreachableCore, path)).toBe(
		false
	);
	expect(existsSync(path)).toBe(false);
	// A sealed file without Core reads as empty and is left alone.
	await saveSealedPromptHistory(["kept"], fakeSealer(), path);
	expect((await loadSealedPromptHistory(null, path)).state.entries).toEqual([]);
	expect(
		(await loadSealedPromptHistory(fakeSealer(), path)).state.entries
	).toEqual(["kept"]);
});

test("never records pasted blocks or slash-command arguments", () => {
	expect(historyEntryFor("  /login sk-secret-key  ")).toBe("/login");
	expect(historyEntryFor("/clear")).toBe("/clear");
	expect(historyEntryFor("explain [Pasted 40 lines #1]")).toBe(
		"explain [Pasted 40 lines #1]"
	);
	const merged = mergeLoadedHistory(
		initialPromptHistory(["older"]),
		initialPromptHistory(["typed while loading"])
	);
	expect(merged.entries).toEqual(["older", "typed while loading"]);
});

test("navigates newest-to-oldest and restores the unsent draft", () => {
	let state = initialPromptHistory(["first", "second"]);
	let result = previousPrompt(state, "draft");
	expect(result.value).toBe("second");
	state = result.state;
	result = previousPrompt(state, result.value);
	expect(result.value).toBe("first");
	state = result.state;
	result = nextPrompt(state, result.value);
	expect(result.value).toBe("second");
	state = result.state;
	result = nextPrompt(state, result.value);
	expect(result.value).toBe("draft");
	expect(result.state.cursor).toBe(-1);
});

test("trims entries, suppresses adjacent duplicates, and resets navigation", () => {
	let state = initialPromptHistory();
	state = recordPrompt(state, "  hello  ");
	state = recordPrompt(state, "hello");
	expect(state.entries).toEqual(["hello"]);
	state = previousPrompt(state, "").state;
	expect(resetPromptNavigation(state).cursor).toBe(-1);
});

test("stores history with owner-only directory and file permissions", async () => {
	const path = join(tempDir, "private", "history.json");
	await saveSealedPromptHistory(["secret"], fakeSealer(), path);
	if (process.platform !== "win32") {
		expect(statSync(join(tempDir, "private")).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	}
});

test("a sealed file Core cannot open is kept and never overwritten", async () => {
	const path = join(tempDir, "history.json");
	const sealer = fakeSealer();
	await saveSealedPromptHistory(["older prompt"], sealer, path);
	const sealed = readFileSync(path, "utf8");

	// Core is starting, signed out, or on another profile's key.
	await expect(loadSealedPromptHistory(unreachableCore, path)).rejects.toThrow(
		PromptHistoryUnreadableError
	);
	await expect(
		loadAndMigratePromptHistory(unreachableCore, path)
	).rejects.toThrow(PromptHistoryUnreadableError);
	expect(readFileSync(path, "utf8")).toBe(sealed);

	// Once Core opens it again the earlier history is all still there.
	expect((await loadAndMigratePromptHistory(sealer, path)).entries).toEqual([
		"older prompt",
	]);
});
