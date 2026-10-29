import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	type DatabaseDoc,
	parseDatabaseDoc,
} from "@/src/lib/realtime/yjs-database.ts";

const documentPath = "/api/spaces/space-proof/documents/database-proof";
async function install(page: Page) {
	let document: DatabaseDoc = {
		columns: [
			{ id: "name", label: "Name", cell: { variant: "short-text" } },
			{
				id: "stage",
				label: "Stage",
				cell: {
					variant: "select",
					options: [{ value: "active", label: "Active", color: "green" }],
				},
			},
		],
		rows: [{ name: "Acme proposal", stage: "active" }],
		views: [{ id: "table", name: "Table", kind: "table" }],
	};
	let failNext = false;
	const writes: Array<{
		body: { title: string; source: string };
		authorization: string | undefined;
		status: number;
	}> = [];
	await page.route(`**${documentPath}`, async (route) => {
		const request = route.request();
		if (request.method() === "PUT") {
			const body = request.postDataJSON();
			writes.push({
				body,
				authorization: request.headers().authorization,
				status: failNext ? 403 : 200,
			});
			if (failNext) {
				failNext = false;
				await route.fulfill({
					status: 403,
					contentType: "application/json",
					body: JSON.stringify({ error: "Document write rejected" }),
				});
				return;
			}
			document = parseDatabaseDoc(body.source);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					result: { changed: true, revision: writes.length },
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				id: "database-proof",
				space_id: "space-proof",
				kind: "database",
				title: "Project database",
				source: JSON.stringify(document),
				chunk_count: 0,
				created_at: 1,
				updated_at: 1,
			}),
		});
	});
	return {
		writes,
		read: () => structuredClone(document),
		fail: () => {
			failNext = true;
		},
	};
}

async function open(page: Page, query = "") {
	await page.goto(`/column-editor-proof.html${query}`);
	await page.getByRole("link", { name: "Open project database" }).click();
	await expect(
		page.getByRole("button", { name: "Add column", exact: true })
	).toBeVisible();
}

async function edit(page: Page, label: string) {
	await page.getByRole("button", { name: label, exact: true }).click();
	await page
		.getByRole("menuitem", { name: "Edit property", exact: true })
		.click();
	await expect(
		page.getByRole("dialog", { name: "Edit property" })
	).toBeVisible();
}

test("creates and edits typed column options through the production database route, retries rejected persistence and reloads exact state", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	await page.getByRole("button", { name: "Add column", exact: true }).click();
	await page.getByPlaceholder("Property name").fill("Canceled property");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(fixture.writes).toHaveLength(0);
	await page.getByRole("button", { name: "Add column", exact: true }).click();
	await page.getByPlaceholder("Property name").fill(" Priority ");
	await page.getByRole("button", { name: "Multi-select", exact: true }).click();
	await page.getByRole("button", { name: "Add option", exact: true }).click();
	await page.getByPlaceholder("Option", { exact: true }).fill(" Critical ");
	await page.getByRole("button", { name: "Option color", exact: true }).click();
	await page.getByRole("button", { name: "red", exact: true }).click();
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Add option", exact: true }).click();
	await page
		.getByRole("button", { name: "Remove option", exact: true })
		.nth(1)
		.click();
	fixture.fail();
	await page.getByRole("button", { name: "Add property", exact: true }).click();
	await expect(
		page.getByText("Saved on this device", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Priority", exact: true })
	).toBeVisible();
	expect(fixture.read().columns).toHaveLength(2);
	const rejected = parseDatabaseDoc(fixture.writes[0]?.body.source ?? "{}");
	const created = rejected.columns[2];
	expect(created).toMatchObject({
		id: expect.stringMatching(/^col_/),
		label: "Priority",
		cell: {
			variant: "multi-select",
			options: [
				{
					value: expect.stringMatching(/^opt_/),
					label: "Critical",
					color: "red",
				},
			],
		},
	});
	expect(rejected.rows[0]?.[created?.id ?? ""]).toEqual([]);
	await edit(page, "Priority");
	await expect(page.getByPlaceholder("Option", { exact: true })).toHaveValue(
		"Critical"
	);
	await page.getByPlaceholder("Property name").fill("Priority saved");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(fixture.writes.at(-1)?.authorization).toBe(
		"Bearer column-proof-node-token"
	);
	expect(fixture.writes.at(-1)?.body.title).toBe("Project database");
	expect(fixture.read().columns[2]).toEqual({
		...created,
		label: "Priority saved",
	});
	await page.reload();
	await page.getByRole("link", { name: "Open project database" }).click();
	await edit(page, "Priority saved");
	await expect(page.getByPlaceholder("Option", { exact: true })).toHaveValue(
		"Critical"
	);
	await page.getByRole("button", { name: "Number", exact: true }).click();
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(page.getByText("Saved", { exact: true })).toBeVisible();
	expect(fixture.read().columns[2]).toEqual({
		id: created?.id,
		label: "Priority saved",
		cell: { variant: "number" },
	});
	expect(fixture.read().rows[0]?.[created?.id ?? ""]).toBeNull();
	await page.reload();
	await page.getByRole("link", { name: "Open project database" }).click();
	await edit(page, "Priority saved");
	await expect(page.getByPlaceholder("Property name")).toHaveValue(
		"Priority saved"
	);
	await expect(page.getByPlaceholder("Option", { exact: true })).toHaveCount(0);
	const proof = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-spaces-column-editor-persisted-number.png"
	);
	await mkdir(path.dirname(proof), { recursive: true });
	await page.screenshot({ animations: "disabled", path: proof });
});

test("read-only database projection disables new properties and removes the edit affordance", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page, "?access=read");
	await expect(
		page.getByRole("button", { name: "Add column", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("textbox", { name: "Database title" })
	).toBeDisabled();
	await page.getByRole("button", { name: "Stage", exact: true }).click();
	await expect(
		page.getByRole("menuitem", { name: "Edit property", exact: true })
	).toHaveCount(0);
	expect(fixture.writes).toHaveLength(0);
});

test("every remaining property type persists its cell contract and default row value", async ({
	page,
}) => {
	const fixture = await install(page);
	await open(page);
	for (const type of [
		{ label: "Text", variant: "short-text", value: "" },
		{ label: "Long text", variant: "long-text", value: "" },
		{ label: "Checkbox", variant: "checkbox", value: false },
		{ label: "Date", variant: "date", value: null },
		{ label: "URL", variant: "url", value: "" },
		{ label: "Select", variant: "select", value: null },
	] as const) {
		await page.getByRole("button", { name: "Add column", exact: true }).click();
		await page
			.getByPlaceholder("Property name")
			.fill(type.label === "Text" ? " " : `${type.label} property`);
		await page
			.getByRole("dialog")
			.getByRole("button", { name: type.label, exact: true })
			.click();
		if (type.variant === "select") {
			await page
				.getByRole("button", { name: "Add option", exact: true })
				.click();
			await page.getByPlaceholder("Option", { exact: true }).fill(" ");
		}
		await page
			.getByRole("button", { name: "Add property", exact: true })
			.click();
		await expect(page.getByText("Saved", { exact: true })).toBeVisible();
		const column = fixture.read().columns.at(-1);
		expect(column?.label).toBe(
			type.label === "Text" ? "Untitled" : `${type.label} property`
		);
		expect(column?.cell).toEqual(
			type.variant === "select"
				? { variant: "select", options: [] }
				: { variant: type.variant }
		);
		expect(fixture.read().rows[0]?.[column?.id ?? ""]).toEqual(type.value);
	}
	await page.reload();
	await page.getByRole("link", { name: "Open project database" }).click();
	await expect(
		page.getByRole("button", { name: "Untitled", exact: true })
	).toBeVisible();
	expect(fixture.read().columns).toHaveLength(8);
});
