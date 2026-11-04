import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rustModuleSource } from "./rust-module-source.ts";

const REPO_ROOT = join(import.meta.dir, "../../../../..");
const DOCUMENT_PARSE = "apps/core/src/document_parse";

describe("rustModuleSource", () => {
	it("reads mod.rs and every glob re-exported part of a split module", () => {
		const source = rustModuleSource(DOCUMENT_PARSE);
		const dir = join(REPO_ROOT, DOCUMENT_PARSE);
		const parts = readdirSync(dir).filter(
			(name) => name.endsWith(".rs") && name !== "mod.rs"
		);
		expect(parts.length).toBeGreaterThan(0);
		for (const part of parts) {
			expect(source).toContain(readFileSync(join(dir, part), "utf8"));
		}
	});

	it("leaves out submodules that keep their own path", () => {
		const tests = readFileSync(
			join(REPO_ROOT, DOCUMENT_PARSE, "tests", "mod.rs"),
			"utf8"
		);
		expect(rustModuleSource(DOCUMENT_PARSE)).not.toContain(tests);
	});

	it("reads the tests module too when asked to include every submodule", () => {
		const tests = readFileSync(
			join(REPO_ROOT, DOCUMENT_PARSE, "tests", "mod.rs"),
			"utf8"
		);
		expect(
			rustModuleSource(DOCUMENT_PARSE, { includeAllSubmodules: true })
		).toContain(tests);
	});

	it("throws when the module is not split into a directory", () => {
		expect(() => rustModuleSource("apps/core/src/no_such_module")).toThrow();
	});
});
