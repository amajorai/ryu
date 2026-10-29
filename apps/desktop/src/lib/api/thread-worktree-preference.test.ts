import { describe, expect, it } from "bun:test";
import { parseThreadWorktreeIsolationDefault } from "./thread-worktree-preference.ts";

describe("coordinator worktree default preference", () => {
	it("defaults to no worktree when unset or malformed", () => {
		expect(parseThreadWorktreeIsolationDefault(null)).toBe(false);
		expect(parseThreadWorktreeIsolationDefault("")).toBe(false);
		expect(parseThreadWorktreeIsolationDefault("not-a-boolean")).toBe(false);
	});

	it("parses saved booleans without depending on casing or whitespace", () => {
		expect(parseThreadWorktreeIsolationDefault(" true ")).toBe(true);
		expect(parseThreadWorktreeIsolationDefault("FALSE")).toBe(false);
	});
});
