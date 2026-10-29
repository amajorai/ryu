import { afterEach, describe, expect, test } from "bun:test";
import { ZodError } from "zod";
import { type CrmObject, type CrmRecord, createCrmClient } from "./crm.ts";

const realFetch = globalThis.fetch;
const client = createCrmClient({
	url: "http://127.0.0.1:7980",
	token: "node-token",
});
const object = {
	id: "people",
	slug: "people",
	singular: "Person",
	plural: "People",
	position: 1,
	is_standard: true,
	created_at: "2026-10-09",
	updated_at: "2026-10-09",
} satisfies CrmObject;
const record = {
	id: "person-1",
	object_id: object.id,
	title: "Ada",
	values: { name: "Ada", score: 7 },
	created_at: "2026-10-09",
	updated_at: "2026-10-09",
} satisfies CrmRecord;
const page = {
	items: [record],
	has_more: false,
	total: 1,
	limit: 25,
	offset: 0,
};
function reply(body: import("@ryu/app-host/json-values").RyuJsonValue) {
	globalThis.fetch = Object.assign(() => Promise.resolve(Response.json(body)), {
		preconnect: realFetch.preconnect,
	});
}
afterEach(() => {
	globalThis.fetch = realFetch;
});
describe("CRM native response decoding", () => {
	test("retains native flattened objects and exposes the public nested object", async () => {
		reply({
			objects: [
				{
					...object,
					fields: [],
					views: [],
					record_count: 1,
					native_extension: "kept",
				},
			],
			lists: [],
		});
		const result = await client.getSchema();
		expect(result.objects[0]?.object).toMatchObject(object);
		expect(result.objects[0]).toMatchObject({
			id: object.id,
			native_extension: "kept",
			record_count: 1,
		});
	});
	test("unwraps the native view page without losing response fields", async () => {
		reply({ page, view_id: "view-1", computed_columns: [] });
		expect(await client.runView("view-1")).toMatchObject({
			...page,
			view_id: "view-1",
			computed_columns: [],
		});
	});
	test("returns the updated record from the native mutation wrapper", async () => {
		reply({ record, changed_fields: ["name"] });
		expect(await client.updateRecord(record.id, { name: "Ada" })).toMatchObject(
			{ ...record, changed_fields: ["name"] }
		);
	});
	test("returns the survivor from the native merge outcome", async () => {
		reply({ survivor: record, merged_ids: ["person-2"] });
		expect(
			await client.mergeRecords({
				survivor_id: record.id,
				loser_ids: ["person-2"],
			})
		).toMatchObject({ ...record, merged_ids: ["person-2"] });
	});
	test("rejects malformed record fields before they reach callers", async () => {
		reply({ ...record, title: 7 });
		await expect(client.getRecord(record.id)).rejects.toBeInstanceOf(ZodError);
	});
	test("does not invent groups from an incompatible native related-record page", async () => {
		reply(page);
		await expect(client.getRelated(record.id)).rejects.toBeInstanceOf(ZodError);
	});
	test("accepts the native 200 JSON delete reply", async () => {
		reply({ ok: true, purged: false });
		expect(await client.deleteRecord(record.id)).toEqual({
			ok: true,
			purged: false,
		});
	});
	test("decodes field reorder as the reordered field array", async () => {
		let sent = "";
		const field = {
			id: "field-1",
			object_id: object.id,
			slug: "name",
			name: "Name",
			field_type: "text",
			position: 0,
			is_required: false,
			is_system: false,
			is_unique: false,
			created_at: "2026-10-09",
			updated_at: "2026-10-09",
		};
		globalThis.fetch = Object.assign(
			(_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sent = String(init?.body);
				return Promise.resolve(Response.json([field]));
			},
			{ preconnect: realFetch.preconnect }
		);
		const fields = await client.reorderFields(object.slug, [field.id]);
		expect(fields).toHaveLength(1);
		expect(JSON.parse(sent)).toEqual({ ids: [field.id] });
	});
	test("decodes link/unlink as a RecordUpdate", async () => {
		let sent = "";
		globalThis.fetch = Object.assign(
			(_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
				sent = String(init?.body);
				return Promise.resolve(Response.json({ record, changed: [] }));
			},
			{ preconnect: realFetch.preconnect }
		);
		expect(await client.link(record.id, "company", ["acme"])).toMatchObject({
			record,
			changed: [],
		});
		expect(JSON.parse(sent)).toEqual({
			field_id: "company",
			target_record_ids: ["acme"],
		});
		expect(await client.unlink(record.id, "company", ["acme"])).toMatchObject({
			record,
		});
	});
});
