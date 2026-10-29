import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, type ApiTarget } from "./client.ts";
import {
	createFetchFixture,
	parseJsonRequestBody,
} from "./test-support/http-fixture.ts";
import {
	deleteWorkingMemory,
	getWorkingMemory,
	updateWorkingMemory,
} from "./working-memory.ts";

const realFetch = globalThis.fetch;
const target: ApiTarget = {
	token: "node-token",
	url: "http://127.0.0.1:7980",
	userJwt: null,
};

afterEach(() => {
	globalThis.fetch = realFetch;
});

const storedSchemaDoc = {
	scope: "resource",
	id: "user-1",
	mode: "schema",
	data: { name: "Ada", prefs: { theme: "dark" } },
	schema: { type: "object" },
	version: 2,
	created_at: 10,
	updated_at: 20,
};

describe("working memory client", () => {
	test("reads a document and maps it to camelCase", async () => {
		const seen: string[] = [];
		globalThis.fetch = createFetchFixture((url, init) => {
			seen.push(`${init.method} ${url}`);
			return Promise.resolve(
				Response.json({
					scope: "resource",
					id: "user-1",
					working_memory: storedSchemaDoc,
				})
			);
		});
		const doc = await getWorkingMemory(target, {
			scope: "resource",
			id: "user-1",
		});
		expect(seen).toEqual([
			"GET http://127.0.0.1:7980/api/memory/working?scope=resource&id=user-1",
		]);
		expect(doc).toEqual({
			scope: "resource",
			id: "user-1",
			mode: "schema",
			data: { name: "Ada", prefs: { theme: "dark" } },
			schema: { type: "object" },
			version: 2,
			createdAt: 10,
			updatedAt: 20,
		});
	});

	test("returns null when nothing is stored and encodes the id", async () => {
		let requested = "";
		globalThis.fetch = createFetchFixture((url) => {
			requested = url;
			return Promise.resolve(
				Response.json({
					scope: "thread",
					id: "a b&c",
					working_memory: null,
				})
			);
		});
		expect(
			await getWorkingMemory(target, { scope: "thread", id: "a b&c" })
		).toBeNull();
		expect(requested).toContain("id=a+b%26c");
	});

	test("updates with a snake_case body", async () => {
		let body: unknown;
		let method = "";
		globalThis.fetch = createFetchFixture((_url, init) => {
			method = String(init.method);
			body = parseJsonRequestBody(init.body);
			return Promise.resolve(
				Response.json({
					scope: "thread",
					id: "conv-1",
					working_memory: {
						scope: "thread",
						id: "conv-1",
						mode: "template",
						content: "# Notes\n- goal: ship",
						template: "# Notes\n- goal:",
						version: 1,
						created_at: 5,
						updated_at: 5,
					},
				})
			);
		});
		const doc = await updateWorkingMemory(
			target,
			{ scope: "thread", id: "conv-1" },
			{
				content: "# Notes\n- goal: ship",
				template: "# Notes\n- goal:",
				expectedVersion: 0,
			}
		);
		expect(method).toBe("PUT");
		expect(body).toEqual({
			content: "# Notes\n- goal: ship",
			template: "# Notes\n- goal:",
			replace: false,
			expected_version: 0,
		});
		expect(doc.content).toBe("# Notes\n- goal: ship");
		expect(doc.version).toBe(1);
	});

	test("surfaces a version conflict as an ApiError", async () => {
		globalThis.fetch = createFetchFixture(() =>
			Promise.resolve(
				Response.json(
					{ error: "working memory changed", current_version: 3 },
					{ status: 409 }
				)
			)
		);
		const failure = updateWorkingMemory(
			target,
			{ scope: "resource", id: "user-1" },
			{ data: { name: null }, expectedVersion: 1 }
		);
		await expect(failure).rejects.toBeInstanceOf(ApiError);
	});

	test("deletes a document", async () => {
		globalThis.fetch = createFetchFixture((_url, init) => {
			expect(init.method).toBe("DELETE");
			return Promise.resolve(Response.json({ deleted: true }));
		});
		expect(
			await deleteWorkingMemory(target, { scope: "thread", id: "conv-1" })
		).toBe(true);
	});
});
