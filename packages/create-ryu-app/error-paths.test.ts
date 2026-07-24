/**
 * Scaffold guard-rail tests — the reject-and-exit branches the happy-path suite
 * never reaches (empty/invalid name, unknown template, existing directory).
 *
 * `scaffold` reports failure via `exitError` → `process.exit(1)`, so each test
 * replaces `process.exit` with a throwing spy (restored per-test so it cannot leak
 * to another file in the same `bun test` process) and asserts BOTH that scaffold
 * bailed and the exact operator-facing message it wrote to stderr. Every branch
 * here throws before any filesystem write, so there is nothing to clean up except
 * the one directory the "already exists" case pre-creates.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { scaffold } from "./index.ts";

const EXIT_SENTINEL = "process.exit called";

let exitSpy: ReturnType<typeof spyOn>;
let stderrSpy: ReturnType<typeof spyOn>;
let stderr: string;

beforeEach(() => {
	stderr = "";
	exitSpy = spyOn(process, "exit").mockImplementation(((_code?: number) => {
		throw new Error(EXIT_SENTINEL);
	}) as never);
	stderrSpy = spyOn(process.stderr, "write").mockImplementation(((
		chunk: string | Uint8Array
	) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
		return true;
	}) as never);
});

afterEach(() => {
	exitSpy.mockRestore();
	stderrSpy.mockRestore();
});

const tmpRoot = join(import.meta.dir, `__test-errors-${Date.now()}`);
afterEach(() => {
	if (existsSync(tmpRoot)) {
		rmSync(tmpRoot, { recursive: true, force: true });
	}
});

describe("scaffold rejects bad input", () => {
	it("empty name → exits with a name-required message", () => {
		expect(() => scaffold("   ", tmpRoot)).toThrow(EXIT_SENTINEL);
		expect(stderr).toContain("name must not be empty");
	});

	it("a name that starts with a hyphen is invalid", () => {
		expect(() => scaffold("-bad", tmpRoot)).toThrow(EXIT_SENTINEL);
		expect(stderr).toContain("name must start with a letter or digit");
	});

	it("a name with a space is invalid", () => {
		expect(() => scaffold("has space", tmpRoot)).toThrow(EXIT_SENTINEL);
		expect(stderr).toContain("name must start with a letter or digit");
	});

	it("a name with a slash (path traversal) is invalid", () => {
		expect(() => scaffold("../evil", tmpRoot)).toThrow(EXIT_SENTINEL);
		expect(stderr).toContain("name must start with a letter or digit");
	});

	it("an unknown template → exits listing the valid templates", () => {
		expect(() => scaffold("ok-name", tmpRoot, "no-such-template")).toThrow(
			EXIT_SENTINEL
		);
		expect(stderr).toContain("unknown template 'no-such-template'");
		expect(stderr).toContain("agent");
	});

	it("an existing target directory → exits without overwriting", () => {
		const projectDir = join(tmpRoot, "taken");
		mkdirSync(projectDir, { recursive: true });
		expect(() => scaffold("taken", tmpRoot)).toThrow(EXIT_SENTINEL);
		expect(stderr).toContain("directory already exists");
		// The pre-existing directory is left intact (never clobbered).
		expect(existsSync(projectDir)).toBe(true);
	});
});
