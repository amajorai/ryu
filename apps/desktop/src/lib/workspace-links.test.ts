import { describe, expect, test } from "bun:test";
import { resolveWorkspaceFilePath } from "./workspace-links.ts";

describe("resolveWorkspaceFilePath", () => {
	test("resolves relative paths and strips line suffixes", () => {
		expect(resolveWorkspaceFilePath("/work/app", "src/App.tsx:12:4")).toBe(
			"/work/app/src/App.tsx"
		);
	});

	test("keeps absolute paths inside the workspace", () => {
		expect(resolveWorkspaceFilePath("/work/app", "/work/app/README.md")).toBe(
			"/work/app/README.md"
		);
	});

	test("rejects traversal and absolute paths outside the workspace", () => {
		expect(resolveWorkspaceFilePath("/work/app", "../secret.txt")).toBeNull();
		expect(resolveWorkspaceFilePath("/work/app", "/etc/passwd")).toBeNull();
		expect(
			resolveWorkspaceFilePath("/work/app", "/work/app/../../etc/x.json")
		).toBeNull();
		expect(
			resolveWorkspaceFilePath("/work/app", "/work/app/./src/../../x")
		).toBeNull();
	});
});
