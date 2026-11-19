// `ryu secrets agent` file writes: atomic replacement, owner-only mode, change
// detection, and no temp files left behind.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	readCredentialFile,
	readIfPresent,
	writeAtomic,
	writeIfChanged,
} from "../cli/secrets-agentd-files.ts";

let dir = "";

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ryu-agentd-files-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("writeAtomic", () => {
	test("replaces the file and leaves no temp file behind", async () => {
		const path = join(dir, "app.env");
		await writeAtomic(path, "A=1\n", 0o600);
		await writeAtomic(path, "A=2\n", 0o600);
		expect(await readFile(path, "utf8")).toBe("A=2\n");
		expect(await readdir(dir)).toEqual(["app.env"]);
	});

	test("creates the file owner-only where the OS has POSIX modes", async () => {
		const path = join(dir, "token");
		await writeAtomic(path, "rvt_x", 0o600);
		const mode = (await stat(path)).mode & 0o777;
		if (process.platform === "win32") {
			// Windows keeps the directory's ACL; only the content is checked.
			expect(await readFile(path, "utf8")).toBe("rvt_x");
		} else {
			expect(mode).toBe(0o600);
		}
	});

	test("a failed rename removes the temp file", async () => {
		// Renaming a file over a non-empty directory fails on every platform.
		const target = join(dir, "is-a-dir");
		await mkdir(join(target, "inner"), { recursive: true });
		await expect(writeAtomic(target, "x", 0o600)).rejects.toThrow();
		expect(await readdir(dir)).toEqual(["is-a-dir"]);
	});
});

describe("writeIfChanged", () => {
	test("reports a change only when the content differs", async () => {
		const path = join(dir, "app.env");
		expect(await writeIfChanged(path, "A=1\n", 0o600)).toBe(true);
		expect(await writeIfChanged(path, "A=1\n", 0o600)).toBe(false);
		expect(await writeIfChanged(path, "A=2\n", 0o600)).toBe(true);
		expect(await readFile(path, "utf8")).toBe("A=2\n");
	});
});

describe("reading", () => {
	test("readIfPresent is null for a missing file", async () => {
		expect(await readIfPresent(join(dir, "nope"))).toBeNull();
	});

	test("readCredentialFile trims the trailing newline", async () => {
		const path = join(dir, "secret-id");
		await writeAtomic(path, "  sid-1\n", 0o600);
		expect(await readCredentialFile(path)).toBe("sid-1");
	});
});
