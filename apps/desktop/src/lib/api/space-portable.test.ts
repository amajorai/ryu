import { afterEach, describe, expect, it } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { exportSpacePackage, importSpacePackage } from "./space-portable.ts";

const TARGET = { token: "node-token", url: "http://core.test" };
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("portable Space API", () => {
	it("exports a package response and normalizes its summary", async () => {
		let called: { body: unknown; method: string; url: string } | undefined;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input: URL | RequestInfo, init?: RequestInit) => {
				called = {
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
					method: init?.method ?? "GET",
					url: String(input),
				};
				return Response.json({
					archive_base64: "AQID",
					content_type: "application/zip",
					filename: "research.ryupack",
					package: {
						databases: 1,
						embeddings: false,
						files: ["index.md", "pages/note.md"],
						name: "Research",
						pages: 1,
						rows: 2,
						version: "1.0.0",
					},
				});
			}
		);

		const exported = await exportSpacePackage(TARGET, "space / one");

		expect(called).toEqual({
			body: {},
			method: "POST",
			url: "http://core.test/api/spaces/space%20%2F%20one/export",
		});
		expect(exported.package).toEqual({
			databases: 1,
			embeddings: false,
			excluded: 0,
			files: ["index.md", "pages/note.md"],
			name: "Research",
			pages: 1,
			rows: 2,
			version: "1.0.0",
		});
	});

	it("sends a binary archive as base64 and accepts an optional name", async () => {
		let called: { body: unknown; method: string; url: string } | undefined;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input: URL | RequestInfo, init?: RequestInit) => {
				called = {
					body: init?.body ? JSON.parse(String(init.body)) : undefined,
					method: init?.method ?? "GET",
					url: String(input),
				};
				return Response.json({
					space: {
						database_count: 1,
						needs_reindex: true,
						page_count: 3,
						row_count: 2,
						space_id: "new-space",
						space_name: "Imported Research",
					},
				});
			}
		);

		const imported = await importSpacePackage(
			TARGET,
			new Uint8Array([0, 1, 2]),
			" Imported Research "
		);

		expect(called).toEqual({
			body: {
				archive_base64: "AAEC",
				name: "Imported Research",
			},
			method: "POST",
			url: "http://core.test/api/spaces/import",
		});
		expect(imported).toEqual({
			databaseCount: 1,
			needsReindex: true,
			pageCount: 3,
			rowCount: 2,
			spaceId: "new-space",
			spaceName: "Imported Research",
		});
	});
});
