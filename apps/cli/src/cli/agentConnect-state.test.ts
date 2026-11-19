import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UnsupportedConfigError } from "./agentConnect-errors.ts";
import {
	isRecordedEntry,
	readConfigFile,
	writeFileAtomic,
} from "./agentConnect-state.ts";
import { entryHash } from "./agentConnect-types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { force: true, recursive: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ryu-agent-state-"));
	dirs.push(dir);
	return dir;
}

describe("agent connect state and IO", () => {
	test("atomic writes round-trip; invalid UTF-8 is refused", () => {
		const dir = tempDir();
		const path = join(dir, "mcp.json");
		expect(readConfigFile(path)).toBeNull();
		writeFileAtomic(path, "{}\n");
		expect(readConfigFile(path)).toBe("{}\n");
		writeFileSync(path, Buffer.from([0xff, 0xfe]));
		expect(() => readConfigFile(path)).toThrow(
			`${path} is not valid UTF-8, so it cannot be edited safely.`
		);
	});

	test("a symlink loop is refused", () => {
		const dir = tempDir();
		const a = join(dir, "a");
		symlinkSync(join(dir, "b"), a);
		symlinkSync(a, join(dir, "b"));
		expect(() => writeFileAtomic(a, "x")).toThrow(UnsupportedConfigError);
	});

	test("an entry is recorded only for its own path and hash", () => {
		const record = {
			configPath: "/x",
			createdFile: false,
			entryHash: entryHash({ url: "u" }),
			mcpUrl: "u",
			tokenMode: "env" as const,
		};
		expect(isRecordedEntry({ url: "u" }, record, "/x")).toBe(true);
		expect(isRecordedEntry({ url: "u" }, record, "/y")).toBe(false);
	});
});
