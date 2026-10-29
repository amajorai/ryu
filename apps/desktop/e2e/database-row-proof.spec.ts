import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import {
	type DatabaseDoc,
	parseDatabaseDoc,
} from "@/src/lib/realtime/yjs-database.ts";

const databasePath = "/api/spaces/space-proof/documents/database-proof";
interface Write {
	body: unknown;
	method: string;
	path: string;
	status: number;
}
async function install(
	page: Page,
	options: { body?: boolean; missingRow?: boolean; legacy?: boolean } = {}
) {
	let database: DatabaseDoc = {
		columns: [
			{ id: "name", label: "Name", cell: { variant: "short-text" } },
			{ id: "done", label: "Done", cell: { variant: "checkbox" } },
			{ id: "notes", label: "Notes", cell: { variant: "long-text" } },
			{ id: "amount", label: "Amount", cell: { variant: "number" } },
			{ id: "due", label: "Due", cell: { variant: "date" } },
			{ id: "link", label: "Website", cell: { variant: "url" } },
			{
				id: "stage",
				label: "Stage",
				cell: {
					variant: "select",
					options: [
						{ label: "Active", value: "active", color: "green" },
						{ label: "Closed", value: "closed", color: "red" },
					],
				},
			},
			{
				id: "tags",
				label: "Tags",
				cell: {
					variant: "multi-select",
					options: [
						{ label: "Important", value: "important", color: "yellow" },
						{ label: "Follow up", value: "follow_up", color: "blue" },
					],
				},
			},
		],
		rows: options.missingRow
			? []
			: [
					{
						...(options.legacy ? undefined : { __id: "row-proof" }),
						...(options.body === false ? undefined : { __page: "body-proof" }),
						name: "Acme proposal",
						done: false,
						notes: "Initial notes",
						amount: 100,
						due: "2026-10-05",
						link: "https://example.invalid",
						stage: "active",
						tags: ["important"],
					},
				],
		views: [
			{ id: "table", name: "Table", kind: "table" },
			{
				id: "board",
				name: "Pipeline",
				kind: "board",
				groupByColumnId: "stage",
			},
		],
	};
	let body = "Project brief.";
	const requests: Write[] = [];
	const failures = new Map<string, number>();
	await page.route("**/api/spaces/space-proof/**", async (route) => {
		const request = route.request();
		const pathname = new URL(request.url()).pathname;
		const method = request.method();
		const input = request.postData() ? request.postDataJSON() : null;
		const key = `${method} ${pathname}`;
		expect(request.headers().authorization).toBe("Bearer row-proof-node-token");
		const failure = failures.get(key);
		requests.push({
			method,
			path: pathname,
			body: input,
			status:
				failure ??
				(method === "POST" && pathname === "/api/spaces/space-proof/pages"
					? 201
					: 200),
		});
		if (failure) {
			failures.delete(key);
			await route.fulfill({
				status: failure,
				contentType: "application/json",
				body: JSON.stringify({ error: "Document write rejected" }),
			});
			return;
		}
		if (method === "POST" && pathname === "/api/spaces/space-proof/pages") {
			await route.fulfill({
				status: 201,
				contentType: "application/json",
				body: JSON.stringify({ id: "body-proof" }),
			});
			return;
		}
		if (method === "PUT") {
			const update = z
				.object({ title: z.string(), source: z.string() })
				.parse(input);
			if (pathname === databasePath) {
				database = parseDatabaseDoc(update.source);
			} else {
				body = update.source;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					result: { changed: true, revision: requests.length },
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				id: pathname.split("/").at(-1),
				space_id: "space-proof",
				kind: pathname === databasePath ? "database" : "page",
				title: pathname === databasePath ? "Project database" : "Acme proposal",
				source: pathname === databasePath ? JSON.stringify(database) : body,
				chunk_count: 0,
				created_at: 1,
				updated_at: 1,
			}),
		});
	});
	return {
		requests,
		read: () => structuredClone(database),
		fail: (method: string, requestPath: string, status = 403) => {
			failures.set(`${method} ${requestPath}`, status);
		},
	};
}

async function open(page: Page, query = "") {
	await page.goto(`/database-row-proof.html${query}`);
	await page.getByRole("link", { name: "Open project database" }).click();
	await page.getByRole("button", { name: "Open row", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Row title" })).toHaveValue(
		"Acme proposal"
	);
}
function property(page: Page, name: string) {
	return page
		.locator("div.flex.items-start.gap-3")
		.filter({ has: page.getByText(name, { exact: true }) });
}

test("all typed row properties save exact values, preserve row identity and views, and read back after grid reopen", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await page
		.getByRole("textbox", { name: "Row title" })
		.fill("Renewal proposal");
	await property(page, "Done").getByRole("checkbox").check();
	await property(page, "Notes").getByRole("textbox").fill("Review with buyer");
	await property(page, "Amount").getByRole("spinbutton").fill("2500");
	await property(page, "Due").locator("input").fill("2026-10-12");
	await property(page, "Website")
		.getByRole("textbox")
		.fill("https://example.invalid/proposal");
	await property(page, "Stage")
		.getByRole("button", { name: "Closed", exact: true })
		.click();
	await property(page, "Stage")
		.getByRole("button", { name: "Closed", exact: true })
		.click();
	await property(page, "Stage")
		.getByRole("button", { name: "Active", exact: true })
		.click();
	await property(page, "Tags")
		.getByRole("button", { name: "Important", exact: true })
		.click();
	await property(page, "Tags")
		.getByRole("button", { name: "Follow up", exact: true })
		.click();
	await expect.poll(() => fixture.read().rows[0]?.amount).toBe(2500);
	expect(fixture.read().rows[0]).toEqual({
		__id: "row-proof",
		__page: "body-proof",
		name: "Renewal proposal",
		done: true,
		notes: "Review with buyer",
		amount: 2500,
		due: "2026-10-12",
		link: "https://example.invalid/proposal",
		stage: "active",
		tags: ["follow_up"],
	});
	expect(fixture.read().views).toEqual([
		{ id: "table", name: "Table", kind: "table" },
		{ id: "board", name: "Pipeline", kind: "board", groupByColumnId: "stage" },
	]);
	await page.reload();
	await page.getByRole("link", { name: "Open project database" }).click();
	await page.getByRole("button", { name: "Open row", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Row title" })).toHaveValue(
		"Renewal proposal"
	);
	await expect(property(page, "Done").getByRole("checkbox")).toBeChecked();
	await expect(property(page, "Amount").getByRole("spinbutton")).toHaveValue(
		"2500"
	);
	await expect(
		property(page, "Stage").getByRole("button", { name: "Active", exact: true })
	).toHaveAttribute("aria-pressed", "true");
	await property(page, "Amount").getByRole("spinbutton").fill("");
	await expect.poll(() => fixture.read().rows[0]?.amount).toBeNull();
	await property(page, "Amount").getByRole("spinbutton").fill("2500");
	await expect.poll(() => fixture.read().rows[0]?.amount).toBe(2500);
	const proof = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-database-row-properties-persisted.png"
	);
	await expect(page.getByText("Project brief.", { exact: true })).toBeVisible({
		timeout: 60_000,
	});
	await mkdir(path.dirname(proof), { recursive: true });
	await page.screenshot({ animations: "disabled", path: proof });
});

test("rejected property save preserves draft, reports failure, retries exact source and survives reload", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	const initialWrites = fixture.requests.filter(
		(request) => request.method === "PUT" && request.path === databasePath
	).length;
	fixture.fail("PUT", databasePath);
	await property(page, "Amount").getByRole("spinbutton").fill("3500");
	await expect(page.getByRole("alert")).toContainText(
		"Couldn't save row changes"
	);
	await expect(property(page, "Amount").getByRole("spinbutton")).toHaveValue(
		"3500"
	);
	expect(fixture.read().rows[0]?.amount).toBe(100);
	await page.getByRole("button", { name: "Retry save", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect.poll(() => fixture.read().rows[0]?.amount).toBe(3500);
	const writes = fixture.requests
		.filter(
			(request) => request.method === "PUT" && request.path === databasePath
		)
		.slice(initialWrites);
	expect(writes).toHaveLength(2);
	expect(writes[0]?.body).toEqual(writes[1]?.body);
	await page.reload();
	await page.getByRole("link", { name: "Open project database" }).click();
	await page.getByRole("button", { name: "Open row", exact: true }).click();
	await expect(property(page, "Amount").getByRole("spinbutton")).toHaveValue(
		"3500"
	);
});

test("read-only first-open does not create a child page and disables every property control", async ({
	page,
}) => {
	const fixture = await install(page, { body: false });
	await open(page, "?access=read");
	await expect(page.getByRole("textbox", { name: "Row title" })).toBeDisabled();
	for (const name of [
		"Done",
		"Notes",
		"Amount",
		"Due",
		"Website",
		"Stage",
		"Tags",
	]) {
		const controls = property(page, name).locator("input,textarea,button");
		for (const control of await controls.all()) {
			await expect(control).toBeDisabled();
		}
	}
	await expect(
		page.getByText("This row has no page yet.", { exact: true })
	).toBeVisible();
	expect(
		fixture.requests.filter((request) => request.method !== "GET")
	).toHaveLength(0);
});

test("read failure and missing row both return to the exact production database route", async ({
	page,
}) => {
	const fixture = await install(page);
	await page.goto("/database-row-proof.html");
	await page.getByRole("link", { name: "Open project database" }).click();
	await expect(
		page.getByRole("button", { name: "Open row", exact: true })
	).toBeVisible();
	fixture.fail("GET", databasePath, 503);
	await page.getByRole("button", { name: "Open row", exact: true }).click();
	await expect(
		page.getByText("Could not open row", { exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Back to database", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Open row", exact: true })
	).toBeVisible();
	await page.goto("/database-row-proof.html");
	await page.getByRole("link", { name: "Open missing row" }).click();
	await expect(page.getByText("Row not found", { exact: true })).toBeVisible();
	await page
		.getByRole("button", { name: "Back to database", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Open row", exact: true })
	).toBeVisible();
	expect(
		await page.evaluate(() =>
			/* SAFETY: The actual database-row proof bridge publishes its locally typed tabOpens array; openTab writes a string path and opaque options before this existing strong route assertion. */ (
				window as typeof window & {
					__databaseRowProof: { tabOpens: unknown[] };
				}
			).__databaseRowProof.tabOpens.at(-1)
		)
	).toEqual({
		path: "/spaces/space-proof/db/database-proof",
		options: { title: "Database" },
	});
});

test("opening a legacy row persists its generated identity before the row route reloads the database", async ({
	page,
}) => {
	const fixture = await install(page, { legacy: true });
	await open(page);
	expect(fixture.read().rows[0]?.__id).toMatch(/^row_/);
	expect(fixture.read().views).toHaveLength(2);
	await expect(page.getByRole("textbox", { name: "Row title" })).toHaveValue(
		"Acme proposal"
	);
});

test("read-only existing body is rendered as non-editable without document writes", async ({
	page,
}) => {
	const fixture = await install(page);
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await open(page, "?access=read");
	await expect
		.poll(
			async () => ({
				bodyCount: await page
					.getByText("Project brief.", { exact: true })
					.count(),
				pageErrors,
			}),
			{ timeout: 60_000 }
		)
		.toEqual({ bodyCount: 1, pageErrors: [] });
	await expect(page.locator('[contenteditable="true"]')).toHaveCount(0);
	expect(
		fixture.requests.filter((request) => request.method !== "GET")
	).toHaveLength(0);
});

test("first writable open creates one child page with the row title and preserves its parent/link after reopen", async ({
	page,
}) => {
	const fixture = await install(page, { body: false });
	await open(page);
	await expect(page.getByText("Project brief.", { exact: true })).toBeVisible({
		timeout: 60_000,
	});
	await expect.poll(() => fixture.read().rows[0]?.__page).toBe("body-proof");
	const creates = fixture.requests.filter(
		(request) =>
			request.method === "POST" &&
			request.path === "/api/spaces/space-proof/pages"
	);
	expect(creates).toEqual([
		{
			method: "POST",
			path: "/api/spaces/space-proof/pages",
			body: { title: "Acme proposal", parent_id: "database-proof" },
			status: 201,
		},
	]);
	await page.reload();
	await page.getByRole("link", { name: "Open project database" }).click();
	await page.getByRole("button", { name: "Open row", exact: true }).click();
	await expect(page.getByText("Project brief.", { exact: true })).toBeVisible({
		timeout: 60_000,
	});
	expect(
		fixture.requests.filter((request) => request.method === "POST")
	).toHaveLength(1);
	expect(fixture.read().views).toHaveLength(2);
});
