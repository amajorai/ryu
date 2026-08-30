import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../../..");

function source(relativePath: string): string {
	return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("memory graph and consent route contract", () => {
	test("keeps the Core routes and the Memory client aligned", () => {
		const server = source("apps/core/src/server/mod.rs");
		const client = source("apps/desktop/src/lib/api/memory.ts");
		expect(server).toContain('"/api/memory/settings"');
		expect(server).toContain('"/api/memory/graph"');
		expect(client).toContain('"/api/memory/settings"');
		expect(client).toContain('"/api/memory/graph"');
	});

	test("does not make the generic retrieval index a Memory app write path", () => {
		const tab = source("apps/desktop/src/components/settings/MemoryTab.tsx");
		expect(tab).toContain("await createMemory(target, { content: trimmed });");
		expect(tab).not.toContain("indexChunk(target");
	});

	test("keeps the agent scope in the public Memory client", () => {
		const client = source("apps/desktop/src/lib/api/memory.ts");
		expect(client).toContain('"agent" | "user" | "node" | "project" | "org"');
		expect(client).toContain('"This agent"');
	});
});
