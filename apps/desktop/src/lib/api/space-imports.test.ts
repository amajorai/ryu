import { afterEach, describe, expect, it } from "bun:test";
import { createFetchFixture } from "../../test-fixtures/native-fetch-fixture.ts";
import { fetchComposioActions } from "./composio.ts";
import {
	createSpaceComposioImport,
	fetchSpaceImports,
} from "./space-imports.ts";

const TARGET = { url: "http://core.test", token: "secret" };
const originalFetch = globalThis.fetch;

function jsonResponse<TFixture>(payload: TFixture): Response {
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

const historyWire = {
	id: "import_1",
	space_id: "space_1",
	source_type: "file" as const,
	source_name: "people.csv",
	source_format: "csv",
	destination_kind: "database" as const,
	status: "completed" as const,
	result_documents: [
		{ id: "doc_1", kind: "database" as const, title: "People" },
	],
	item_count: 2,
	byte_size: 48,
	message: null,
	created_at: 1_700_000_000_000,
	updated_at: 1_700_000_000_100,
	completed_at: 1_700_000_000_100,
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Space import API", () => {
	it("keeps the Composio input schema needed by the import form", async () => {
		let calledUrl = "";
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input: URL | RequestInfo) => {
				calledUrl = String(input);
				return jsonResponse({
					data: [
						{
							name: "GITHUB_LIST_ISSUES",
							display_name: "List issues",
							toolkit: "github",
							tags: ["readOnlyHint"],
							input_schema: {
								type: "object",
								required: ["repo"],
								properties: { repo: { type: "string", title: "Repository" } },
							},
						},
					],
				});
			}
		);

		const [action] = await fetchComposioActions(TARGET, "github", "", [
			"readOnlyHint",
		]);
		expect(calledUrl).toContain("tags=readOnlyHint");
		expect(action?.tags).toEqual(["readOnlyHint"]);
		expect(action?.inputSchema.required).toEqual(["repo"]);
		expect(action?.inputSchema.properties?.repo?.title).toBe("Repository");
	});

	it("normalizes durable history and every result document", async () => {
		let calledUrl = "";
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input: URL | RequestInfo) => {
				calledUrl = String(input);
				return jsonResponse({ imports: [historyWire] });
			}
		);

		const history = await fetchSpaceImports(TARGET, "space / one");

		expect(calledUrl).toBe(
			"http://core.test/api/spaces/space%20%2F%20one/imports"
		);
		expect(history).toEqual([
			{
				id: "import_1",
				spaceId: "space_1",
				sourceType: "file",
				sourceName: "people.csv",
				sourceFormat: "csv",
				destinationKind: "database",
				status: "completed",
				resultDocuments: [{ id: "doc_1", kind: "database", title: "People" }],
				itemCount: 2,
				byteSize: 48,
				message: null,
				createdAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_100,
				completedAt: 1_700_000_000_100,
			},
		]);
	});

	it("lists connector imports with their provider as the format", async () => {
		globalThis.fetch = createFetchFixture(originalFetch, async () =>
			jsonResponse({
				imports: [
					historyWire,
					{
						...historyWire,
						id: "import_2",
						source_type: "connector",
						source_name: "Notion",
						source_format: "notion",
						destination_kind: "page",
					},
				],
			})
		);

		const history = await fetchSpaceImports(TARGET, "space_1");

		expect(history.map((item) => [item.sourceType, item.sourceFormat])).toEqual(
			[
				["file", "csv"],
				["connector", "notion"],
			]
		);
	});

	it("sends Composio imports to the scoped route with snake-case destination", async () => {
		let call: { body: unknown; method: string; url: string } | undefined;
		globalThis.fetch = createFetchFixture(
			originalFetch,
			async (input: URL | RequestInfo, init?: RequestInit) => {
				call = {
					url: String(input),
					method: init?.method ?? "GET",
					body: JSON.parse(String(init?.body ?? "{}")),
				};
				return jsonResponse({
					import: { ...historyWire, source_type: "composio" },
				});
			}
		);

		await createSpaceComposioImport(TARGET, "space_1", {
			toolkit: "github",
			action: "GITHUB_LIST_ISSUES",
			arguments: { owner: "amajorai" },
			destinationKind: "database",
			title: "Issues",
		});

		expect(call).toEqual({
			url: "http://core.test/api/spaces/space_1/imports/composio",
			method: "POST",
			body: {
				toolkit: "github",
				action: "GITHUB_LIST_ISSUES",
				arguments: { owner: "amajorai" },
				destination_kind: "database",
				title: "Issues",
			},
		});
	});
});
