import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type { CrmRecord, Field, SchemaResponse } from "@/src/lib/api/crm.ts";

const timestamp = "2026-10-02T00:00:00.000Z";
const queryPath = "/api/crm/objects/deal/records/query";
interface RequestEvidence {
	authorization: string | null;
	body: unknown;
	method: string;
	path: string;
	status: number;
}

function field(
	id: string,
	slug: string,
	name: string,
	fieldType: Field["field_type"],
	system = false
): Field {
	return {
		id,
		slug,
		name,
		field_type: fieldType,
		object_id: "obj_deal",
		position: 0,
		is_system: system,
		is_required: false,
		is_unique: false,
		created_at: timestamp,
		updated_at: timestamp,
	};
}

async function install(page: Page) {
	const fields = [
		field("title", "title", "Deal name", "text", true),
		field("amount", "amount", "Amount", "number"),
		field("memo", "memo", "Memo", "text"),
	];
	const records = new Map<string, CrmRecord>(
		Array.from({ length: 52 }, (_, index) => {
			const id = `deal_${index + 1}`;
			const title = `Deal ${String(index + 1).padStart(2, "0")}`;
			return [
				id,
				{
					id,
					title,
					object_id: "obj_deal",
					created_at: timestamp,
					updated_at: timestamp,
					values: {
						title,
						amount: index + 1,
						memo: "Original memo",
						hidden: "Keep hidden value",
					},
				},
			];
		})
	);
	const schema: SchemaResponse = {
		lists: [],
		objects: [
			{
				object: {
					id: "obj_deal",
					slug: "deal",
					singular: "Deal",
					plural: "Deals",
					title_field_id: "title",
					position: 0,
					is_standard: true,
					created_at: timestamp,
					updated_at: timestamp,
				},
				fields,
				record_count: 52,
				views: [
					{
						id: "view_all",
						name: "All deals",
						kind: "table",
						object_id: "obj_deal",
						is_default: true,
						position: 0,
						filter: null,
						sorts: [],
						visible_field_ids: ["amount", "memo", "title"],
						created_at: timestamp,
						updated_at: timestamp,
					},
				],
			},
		],
	};
	const requests: RequestEvidence[] = [];
	const failures = new Map<string, number>();
	await page.route("**/api/crm/**", async (route) => {
		const request = route.request();
		const url = new URL(request.url());
		const requestPath = url.pathname + url.search;
		const method = request.method();
		const body = request.postData() ? request.postDataJSON() : null;
		const key = `${method} ${url.pathname}`;
		const reply = async <FixturePayload>(
			status: number,
			payload: FixturePayload
		) => {
			requests.push({
				authorization: request.headers().authorization ?? null,
				method,
				path: requestPath,
				body,
				status,
			});
			await route.fulfill({
				status,
				contentType: "application/json",
				body: status === 204 ? undefined : JSON.stringify(payload),
			});
		};
		const failure = failures.get(key);
		if (failure) {
			failures.delete(key);
			await reply(failure, {
				error:
					failure === 403
						? "You do not have permission to change this record."
						: "Temporary table request failure",
			});
			return;
		}
		if (method === "GET" && url.pathname === "/api/crm/schema") {
			await reply(200, schema);
			return;
		}
		if (method === "GET" && url.pathname === "/api/crm/search") {
			await reply(503, { error: "Search unavailable" });
			return;
		}
		if (method === "POST" && url.pathname === queryPath) {
			const query = z
				.object({
					search: z.string().nullish(),
					offset: z.number().optional(),
					limit: z.number().optional(),
					sorts: z
						.array(z.object({ direction: z.enum(["asc", "desc"]) }))
						.optional(),
				})
				.parse(body);
			const rows = [...records.values()].filter(
				(record) =>
					!record.deleted_at &&
					(!query.search || record.title?.includes(query.search))
			);
			const sort = query.sorts?.[0];
			if (sort) {
				rows.sort(
					(left, right) =>
						(Number(left.values?.amount) - Number(right.values?.amount)) *
						(sort.direction === "desc" ? -1 : 1)
				);
			}
			await reply(200, {
				total: rows.length,
				has_more: (query.offset ?? 0) + (query.limit ?? 50) < rows.length,
				items: rows.slice(
					query.offset ?? 0,
					(query.offset ?? 0) + (query.limit ?? 50)
				),
			});
			return;
		}
		if (method === "POST" && url.pathname === "/api/crm/objects/deal/records") {
			const created: CrmRecord = {
				id: "deal_created",
				title: "Untitled deal",
				object_id: "obj_deal",
				created_at: timestamp,
				updated_at: timestamp,
				values: {},
			};
			records.set(created.id, created);
			await reply(201, created);
			return;
		}
		if (
			method === "GET" &&
			url.pathname === "/api/crm/exports/views/view_all"
		) {
			requests.push({
				authorization: request.headers().authorization ?? null,
				method,
				path: requestPath,
				body,
				status: 200,
			});
			await route.fulfill({
				status: 200,
				contentType: "text/csv",
				body:
					"Name,Amount\n" +
					[...records.values()]
						.filter((record) => !record.deleted_at)
						.map((record) => `${record.title},${record.values?.amount ?? ""}`)
						.join("\n"),
			});
			return;
		}
		const id = url.pathname.split("/")[4];
		const record = id ? records.get(id) : undefined;
		if (record && url.pathname === `/api/crm/records/${id}`) {
			if (method === "PATCH") {
				const update = z
					.object({ values: z.record(z.string(), z.json()) })
					.parse(body);
				record.values = { ...record.values, ...update.values };
			}
			if (method === "DELETE") {
				record.deleted_at = timestamp;
				await reply(204, null);
				return;
			}
			await reply(200, record);
			return;
		}
		if (record && url.pathname.endsWith("/related")) {
			await reply(200, { groups: [] });
			return;
		}
		if (record && url.pathname.endsWith("/activities")) {
			await reply(200, { items: [], total: 0, has_more: false });
			return;
		}
		await reply(404, { error: `Unexpected table request ${key}` });
	});
	return {
		records,
		requests,
		fail: (method: string, requestPath: string, status = 503) =>
			failures.set(`${method} ${requestPath}`, status),
	};
}

async function open(page: Page) {
	await page.goto("/crm-record-table-proof.html");
	await expect(
		page.getByRole("button", { name: "Deal 01", exact: true }).first()
	).toBeVisible();
}

test("sorts and pages on the server, resets page and selection when narrowing, and retries a query", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await expect(
		page.getByRole("button", { name: "Previous", exact: true })
	).toBeDisabled();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.getByText("51–52 of 52")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Next", exact: true })
	).toBeDisabled();
	expect(fixture.requests.at(-1)?.body).toEqual({
		filter: null,
		limit: 50,
		offset: 50,
		search: null,
		sorts: [],
	});
	await page.getByRole("button", { name: "Previous", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Deal 01", exact: true }).first()
	).toBeVisible();
	await page
		.getByRole("checkbox", { name: "Select Deal 01", exact: true })
		.click();
	await page
		.getByRole("button", { name: "Amount activate to sort", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: /Amount.*sorted ascending/ })
	).toBeVisible();
	await page.getByRole("button", { name: /Amount.*sorted ascending/ }).click();
	await expect(
		page.getByRole("button", { name: "Deal 52", exact: true }).first()
	).toBeVisible();
	expect(fixture.requests.at(-1)?.body).toEqual({
		filter: null,
		limit: 50,
		offset: 0,
		search: null,
		sorts: [{ direction: "desc", field_id: "amount" }],
	});
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await expect(page.getByText("51–52 of 52")).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search all records" })
		.fill("Deal 52");
	await expect(
		page.getByRole("button", { name: "Deal 52", exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("1 Deal", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete", exact: true })
	).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.path === queryPath).at(-1)
			?.body
	).toEqual({
		filter: null,
		limit: 50,
		offset: 0,
		search: "Deal 52",
		sorts: [{ direction: "desc", field_id: "amount" }],
	});
	fixture.fail("POST", queryPath);
	await page
		.getByRole("textbox", { name: "Search all records" })
		.fill("No match");
	await expect(page.getByText("Temporary table request failure")).toBeVisible();
	await page
		.getByRole("textbox", { name: "Search all records" })
		.fill("Deal 51");
	await expect(
		page.getByRole("button", { name: "Deal 51", exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("Temporary table request failure")).toHaveCount(
		0
	);
});

test("inline merge rolls back denied edits, retries and reloads persisted values; system cells stay locked", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	const row = page.getByRole("row").filter({
		has: page.getByRole("checkbox", { name: "Select Deal 01", exact: true }),
	});
	await expect(
		row.getByRole("button", { name: "Deal 01", exact: true }).nth(1)
	).toBeDisabled();
	fixture.fail("PATCH", "/api/crm/records/deal_1", 403);
	await row.getByRole("button", { name: "1", exact: true }).click();
	await row.getByRole("spinbutton").fill("900");
	await row.getByRole("spinbutton").press("Tab");
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toBeVisible();
	await expect(
		row.getByRole("button", { name: "1", exact: true })
	).toBeVisible();
	expect(fixture.records.get("deal_1")?.values?.amount).toBe(1);
	await row.getByRole("button", { name: "1", exact: true }).click();
	await row.getByRole("spinbutton").fill("900");
	await row.getByRole("spinbutton").press("Tab");
	await expect(
		row.getByRole("button", { name: "900", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toHaveCount(0);
	expect(
		fixture.requests
			.filter((request) => request.method === "PATCH")
			.map((request) => request.body)
	).toEqual([
		{ mode: "merge", values: { amount: 900 } },
		{ mode: "merge", values: { amount: 900 } },
	]);
	expect(fixture.records.get("deal_1")?.values?.hidden).toBe(
		"Keep hidden value"
	);
	await row.getByRole("button", { name: "Original memo", exact: true }).click();
	await row.getByRole("textbox").fill("Canceled edit");
	await row.getByRole("textbox").press("Escape");
	expect(
		fixture.requests.filter((request) => request.method === "PATCH")
	).toHaveLength(2);
	await page.reload();
	await expect(
		page
			.getByRole("row")
			.filter({
				has: page.getByRole("checkbox", {
					name: "Select Deal 01",
					exact: true,
				}),
			})
			.getByRole("button", { name: "900", exact: true })
	).toBeVisible();
});

test("selection, denied bulk deletion, retry, full-view CSV export, and record creation read back accepted state", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	const selectAll = page.getByRole("checkbox", {
		name: "Select all rows on this page",
	});
	await selectAll.click();
	await expect(page.getByText("50 selected", { exact: true })).toBeVisible();
	await selectAll.click();
	await expect(
		page.getByRole("button", { name: "Delete", exact: true })
	).toHaveCount(0);
	await page
		.getByRole("checkbox", { name: "Select Deal 01", exact: true })
		.click();
	fixture.fail("DELETE", "/api/crm/records/deal_1", 403);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Deal 01", exact: true }).first()
	).toBeVisible();
	await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Deal 01", exact: true }).first()
	).toHaveCount(0);
	await expect(page.getByText("51 Deals", { exact: true })).toBeVisible();
	expect(fixture.records.get("deal_1")?.deleted_at).toBe(timestamp);
	expect(
		fixture.requests
			.filter((request) => request.method === "DELETE")
			.map((request) => ({
				path: request.path,
				body: request.body,
				status: request.status,
			}))
	).toEqual([
		{ path: "/api/crm/records/deal_1", body: null, status: 403 },
		{ path: "/api/crm/records/deal_1", body: null, status: 204 },
	]);
	fixture.fail("GET", "/api/crm/exports/views/view_all");
	await page.getByRole("button", { name: "Export CSV" }).click();
	await expect(
		page.getByText("Service Unavailable", { exact: true })
	).toBeVisible();
	const downloaded = page.waitForEvent("download");
	await page.getByRole("button", { name: "Export CSV" }).click();
	const download = await downloaded;
	expect(download.suggestedFilename()).toBe("deal-All deals.csv");
	const savedPath = await download.path();
	expect(savedPath).toBeTruthy();
	const csv = await readFile(savedPath, "utf8");
	expect(csv).toContain("Deal 52,52");
	expect(csv).not.toContain("Deal 01,1");
	expect(csv.trim().split("\n")).toHaveLength(52);
	fixture.fail("POST", "/api/crm/objects/deal/records", 403);
	await page.getByRole("button", { name: "New Deal", exact: true }).click();
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toBeVisible();
	expect(fixture.records.has("deal_created")).toBe(false);
	await page.getByRole("button", { name: "New Deal", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Untitled deal" })
	).toBeVisible();
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toHaveCount(0);
	expect(
		fixture.requests
			.filter((request) => request.path === "/api/crm/objects/deal/records")
			.map((request) => request.body)
	).toEqual([{ values: {} }, { values: {} }]);
	await page.getByRole("button", { name: "← Back" }).click();
	await expect(page.getByText("52 Deals", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page
		.getByRole("button", { name: "Untitled deal", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Untitled deal" })
	).toBeVisible();
	const proof = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-crm-record-table-created-readback.png"
	);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method === "GET" &&
				request.path === "/api/crm/records/deal_created"
		)
	).toHaveLength(2);
	await page.getByRole("button", { name: "← Back" }).click();
	await page
		.getByRole("textbox", { name: "Search all records" })
		.fill("Untitled");
	await expect(
		page.getByRole("button", { name: "Untitled deal", exact: true })
	).toBeVisible();
	await expect(page.getByText("1 Deal", { exact: true })).toBeVisible();
	await mkdir(path.dirname(proof), { recursive: true });
	await page.screenshot({ animations: "disabled", path: proof });
	expect(
		fixture.requests.every(
			(request) => request.authorization === "Bearer crm-table-proof-node-token"
		)
	).toBe(true);
});

test("partial bulk deletion reloads accepted removals and retries only the rejected selection", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await page
		.getByRole("checkbox", { name: "Select Deal 01", exact: true })
		.click();
	await page
		.getByRole("checkbox", { name: "Select Deal 02", exact: true })
		.click();
	fixture.fail("DELETE", "/api/crm/records/deal_1", 403);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Select Deal 01", exact: true })
	).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Select Deal 02", exact: true })
	).toHaveCount(0);
	expect(fixture.records.get("deal_1")?.deleted_at).toBeUndefined();
	expect(fixture.records.get("deal_2")?.deleted_at).toBe(timestamp);
	await page.getByRole("button", { name: "Delete", exact: true }).click();
	await expect(page.getByText("50 Deals", { exact: true })).toBeVisible();
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toHaveCount(0);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method === "DELETE" &&
				request.path === "/api/crm/records/deal_1"
		)
	).toHaveLength(2);
	expect(
		fixture.requests.filter(
			(request) =>
				request.method === "DELETE" &&
				request.path === "/api/crm/records/deal_2"
		)
	).toHaveLength(1);
	await page.reload();
	await expect(page.getByText("50 Deals", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Select Deal 01", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("checkbox", { name: "Select Deal 02", exact: true })
	).toHaveCount(0);
});
