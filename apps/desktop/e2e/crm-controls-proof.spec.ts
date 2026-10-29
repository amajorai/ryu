import { mkdir } from "node:fs/promises";
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
		field("memo", "memo", "Memo", "long_text"),
		field("money", "money", "Budget", "currency"),
		field("rating", "rating", "Rating", "rating"),
		field("date", "date", "Due date", "date"),
		field("datetime", "datetime", "Meeting", "datetime"),
		field("flag", "flag", "Qualified", "checkbox"),
		{
			...field("stage", "stage", "Stage", "select"),
			config: {
				options: [
					{ id: "new", label: "New" },
					{ id: "won", label: "Won" },
				],
			},
		},
		field("url", "url", "Website", "url"),
		field("email", "email", "Email", "email"),
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
						money: 1234,
						rating: 3,
						date: "2026-10-03T00:00:00.000Z",
						datetime: "2026-10-03T12:30:00.000Z",
						flag: false,
						stage: "new",
						url: "https://example.com",
						email: "person@example.com",
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
	let releaseCreate: (() => void) | undefined;
	let creationGate: Promise<void> | undefined;
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
			const q = url.searchParams.get("q");
			if (q === "failure") {
				await reply(503, { error: "Search unavailable" });
				return;
			}
			if (q === "slow") {
				await new Promise((resolve) => setTimeout(resolve, 700));
			}
			await reply(200, {
				hits:
					q === "none"
						? []
						: [
								{
									record_id: "deal_1",
									object_slug: "deal",
									title: `Result ${q}`,
									snippet: "Fixture search hit",
								},
							],
			});
			return;
		}
		if (method === "POST" && url.pathname === queryPath) {
			const query = z
				.object({
					search: z.string().optional(),
					sorts: z
						.array(
							z.object({
								field_id: z.string().optional(),
								direction: z.enum(["asc", "desc"]),
							})
						)
						.optional(),
					limit: z.number().optional(),
					offset: z.number().optional(),
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
			if (creationGate) {
				await creationGate;
			}
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
		pauseCreate: () => {
			creationGate = new Promise<void>((resolve) => {
				releaseCreate = resolve;
			});
		},
		releaseCreate: () => releaseCreate?.(),
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
async function capture(page: Page, name: string) {
	const target = path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/parallel/desktop-data-flows/crm/${name}.png`
	);
	await mkdir(path.dirname(target), { recursive: true });
	await page.screenshot({ path: target, animations: "disabled" });
}
test("schema retry and global search discard old hits, preserve fallback, navigate returned record", async ({
	page,
}) => {
	const f = await install(page);
	f.fail("GET", "/api/crm/schema", 403);
	await page.goto("/crm-record-table-proof.html");
	await expect(
		page.getByText("You do not have permission to change this record.")
	).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const search = page.getByRole("textbox", { name: "Search all records" });
	await search.fill("  alpha  ");
	await expect(
		page.getByRole("button", { name: /Result alpha/ })
	).toBeVisible();
	expect(
		f.requests.filter((r) => r.path.startsWith("/api/crm/search")).at(-1)
	).toMatchObject({
		method: "GET",
		path: "/api/crm/search?q=alpha",
		authorization: "Bearer crm-table-proof-node-token",
		body: null,
	});
	await search.fill("failure");
	await expect(page.getByRole("button", { name: /Result alpha/ })).toHaveCount(
		0
	);
	await expect
		.poll(
			() =>
				f.requests.filter((r) => r.path === "/api/crm/search?q=failure").length
		)
		.toBe(1);
	await expect(page.getByRole("button", { name: /All deals/ })).toBeVisible();
	const slow = page.waitForRequest("**/api/crm/search?q=slow");
	await search.fill("slow");
	await slow;
	await search.fill("fresh");
	await expect(
		page.getByRole("button", { name: /Result fresh/ })
	).toBeVisible();
	await page.waitForTimeout(800);
	await expect(page.getByRole("button", { name: /Result slow/ })).toHaveCount(
		0
	);
	await search.fill("none");
	await expect(page.getByText("Nothing matched.")).toBeVisible();
	await search.fill("fresh");
	await page.getByRole("button", { name: /Result fresh/ }).click();
	await expect(page.getByRole("heading", { name: "Deal 01" })).toBeVisible();
	await capture(page, "search-hit-opened");
});
test("rail create denial retry deduplicates while pending and reads back accepted record", async ({
	page,
}) => {
	const f = await install(page);
	await open(page);
	const create = page.getByRole("button", { name: "New record", exact: true });
	f.fail("POST", "/api/crm/objects/deal/records", 403);
	await create.click();
	await expect(page.getByRole("alert")).toContainText(
		"You do not have permission"
	);
	expect(f.records.has("deal_created")).toBe(false);
	f.pauseCreate();
	await create.click();
	await expect(create).toBeDisabled();
	await page.getByRole("button", { name: "New Deal", exact: true }).click();
	f.releaseCreate();
	await expect(
		page.getByRole("heading", { name: "Untitled deal" })
	).toBeVisible();
	expect(
		f.requests
			.filter((r) => r.path === "/api/crm/objects/deal/records")
			.map((r) => ({ body: r.body, status: r.status }))
	).toEqual([
		{ body: { values: {} }, status: 403 },
		{ body: { values: {} }, status: 201 },
	]);
	await page.getByRole("button", { name: "← Back" }).click();
	await page.getByRole("button", { name: "Next", exact: true }).click();
	await page
		.getByRole("button", { name: "Untitled deal", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Untitled deal" })
	).toBeVisible();
	await capture(page, "created-readback");
});
test("detail editors validate, cancel, commit typed values and read back", async ({
	page,
}) => {
	const f = await install(page);
	await open(page);
	await page
		.getByRole("button", { name: "Deal 01", exact: true })
		.first()
		.click();
	const detail = page.locator("dl");
	const field = (name: string) =>
		detail
			.locator("div")
			.filter({ has: page.locator("dt", { hasText: name }) })
			.first();
	const budget = field("Budget");
	await budget.getByRole("button").click();
	const money = budget.getByRole("textbox");
	await money.fill("12oops");
	await money.press("Tab");
	expect(f.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
	await expect(money).toHaveJSProperty(
		"validationMessage",
		"Enter a valid currency amount."
	);
	await money.fill("42.005");
	await money.press("Tab");
	await expect.poll(() => f.records.get("deal_1")?.values?.money).toBe(4201);
	const rating = field("Rating");
	await rating.getByRole("button").click();
	await rating.getByRole("spinbutton").fill("6");
	await rating.getByRole("spinbutton").press("Tab");
	expect(f.records.get("deal_1")?.values?.rating).toBe(3);
	await rating.getByRole("spinbutton").fill("4");
	await rating.getByRole("spinbutton").press("Tab");
	await expect.poll(() => f.records.get("deal_1")?.values?.rating).toBe(4);
	const memo = field("Memo");
	await memo.getByRole("button").click();
	await memo.getByRole("textbox").fill("Canceled");
	await memo.getByRole("textbox").press("Escape");
	expect(f.records.get("deal_1")?.values?.memo).toBe("Original memo");
	await memo.getByRole("button").click();
	await memo.getByRole("textbox").fill("Saved multiline\nsecond line");
	await memo.getByRole("textbox").press("Tab");
	await expect
		.poll(() => f.records.get("deal_1")?.values?.memo)
		.toBe("Saved multiline\nsecond line");
	const stage = field("Stage");
	await stage.getByRole("button").click();
	await stage.getByRole("combobox").selectOption("won");
	await expect.poll(() => f.records.get("deal_1")?.values?.stage).toBe("won");
	const flag = field("Qualified");
	await expect(flag.getByRole("checkbox")).toBeDisabled();
	await flag.getByRole("button").click();
	await flag.getByRole("checkbox").click();
	await expect.poll(() => f.records.get("deal_1")?.values?.flag).toBe(true);
	// Native date controls contain multiple keyboard segments: one Tab may keep
	// focus inside the input. Leave the editor with a physical pointer action.
	for (const [name, input, value, expected] of [
		["Due date", "2026-11-02", "date", "2026-11-02T00:00:00.000Z"],
		["Meeting", "2026-11-02T14:30", "datetime", "2026-11-02T14:30:00.000Z"],
	] as const) {
		const row = field(name);
		await row.getByRole("button").click();
		await row.locator("input").fill(input);
		await expect(row.locator("input")).toHaveValue(input);
		await page.getByRole("heading", { name: "Deal 01", exact: true }).click();
		await expect(row.locator("input")).toHaveCount(0);
		await expect
			.poll(() => f.records.get("deal_1")?.values?.[value])
			.toBe(expected);
		expect(
			f.requests
				.filter(
					(request) =>
						request.method === "PATCH" &&
						request.path === "/api/crm/records/deal_1"
				)
				.map((request) => ({ body: request.body, status: request.status }))
		).toContainEqual({
			body: { mode: "merge", values: { [value]: expected } },
			status: 200,
		});
	}
	expect(f.records.get("deal_1")?.values?.hidden).toBe("Keep hidden value");
	await expect(
		detail.getByRole("link", { name: "https://example.com" })
	).toHaveAttribute("href", "https://example.com/");
	await expect(
		detail.getByRole("link", { name: "person@example.com" })
	).toHaveAttribute("href", "mailto:person@example.com");
	await page.getByRole("button", { name: "← Back" }).click();
	await page
		.getByRole("button", { name: "Deal 01", exact: true })
		.first()
		.click();
	await expect(field("Budget").getByRole("button")).toContainText("42.01");
	await expect(field("Stage").getByRole("button")).toContainText("Won");
	await capture(page, "editors-readback");
	expect(
		f.requests
			.filter((r) => r.method === "PATCH")
			.every((r) => r.authorization === "Bearer crm-table-proof-node-token")
	).toBe(true);
});
