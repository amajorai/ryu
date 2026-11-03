import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { workspaceLauncher, workspaceProgram } from "../program.ts";

describe("workspace launcher", () => {
	test("runs this checkout's bin from source with bun, by a path that exists", () => {
		const [command, bin] = workspaceLauncher();
		expect(command).toBe("bun");
		expect(bin).toMatch(/\/packages\/services-cli\/src\/bin\.ts$/u);
		expect(existsSync(bin ?? "")).toBe(true);
	});

	test("a built module launches the sibling bin.js with node", () => {
		const [command, bin] = workspaceLauncher(
			new URL("../../dist/program.js", import.meta.url).href
		);
		expect(command).toBe("node");
		expect(bin).toMatch(/\/packages\/services-cli\/dist\/bin\.js$/u);
	});

	test("the bin path uses `/` on every OS, so the printed line needs no quoting", () => {
		// A Windows path (`D:\checkout\...`) would be quoted as `'D:\...'`, which
		// cmd does not understand; `D:/checkout/...` runs in every shell.
		const [, bin] = workspaceLauncher();
		expect(bin).not.toContain("\\");
		expect(workspaceProgram()).toStartWith("bun ");
		expect(workspaceProgram()).not.toContain("\\");
	});
});
