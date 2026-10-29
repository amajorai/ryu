import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ACCESS_FREE_COMMANDS, requiresWaitlistAccess } from "../cli/access.ts";

describe("waitlist access gate", () => {
	test("ryu services skips the gate, with or without a subcommand", () => {
		expect(ACCESS_FREE_COMMANDS.has("services")).toBe(true);
		expect(requiresWaitlistAccess(["services", "notify", "publish"])).toBe(
			false
		);
		expect(requiresWaitlistAccess(["services", "--help"])).toBe(false);
		expect(requiresWaitlistAccess(["services", "doctor", "--check"])).toBe(
			false
		);
		expect(requiresWaitlistAccess(["services", "mcp"])).toBe(false);
	});

	test("Core commands still need access, and no command opens the shell", () => {
		expect(requiresWaitlistAccess(["chat", "hello"])).toBe(true);
		expect(requiresWaitlistAccess(["login"])).toBe(false);
		expect(requiresWaitlistAccess([])).toBe(false);
	});

	test("an access-free command keeps its exemption when called by alias", () => {
		expect(requiresWaitlistAccess(["package", "validate", "x"])).toBe(false);
		expect(requiresWaitlistAccess(["pkg", "validate", "x"])).toBe(
			requiresWaitlistAccess(["package", "validate", "x"])
		);
		expect(requiresWaitlistAccess(["troubleshoot"])).toBe(false);
		expect(requiresWaitlistAccess(["bug-report", "--fix"])).toBe(false);
	});

	test("value flags before the command do not change the decision", () => {
		expect(
			requiresWaitlistAccess(["--node", "prod", "package", "validate", "x"])
		).toBe(false);
		expect(requiresWaitlistAccess(["--node", "prod", "pkg", "inspect"])).toBe(
			false
		);
		expect(requiresWaitlistAccess(["--node", "prod", "list"])).toBe(true);
	});

	test("aliases of gated commands stay gated", () => {
		expect(requiresWaitlistAccess(["ls"])).toBe(true);
		expect(requiresWaitlistAccess(["rm", "whiteboard"])).toBe(true);
		expect(requiresWaitlistAccess(["install", "whiteboard"])).toBe(true);
		// An app-contributed command is not a built-in, so it is gated too.
		expect(requiresWaitlistAccess(["mail-contributor", "status"])).toBe(true);
	});

	test("the entry point uses this predicate rather than its own copy", () => {
		const entry = readFileSync(join(import.meta.dir, "../index.tsx"), "utf8");
		expect(entry).toContain('from "./cli/access.ts"');
		expect(entry).not.toContain("const ACCESS_FREE_COMMANDS");
	});
});
