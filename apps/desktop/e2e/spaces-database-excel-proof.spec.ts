import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

// Drives the real SpaceDatabaseEditorPage (local, non-collaborative path) through
// the spreadsheet features: formula columns, conditional formatting, the fill
// handle, undo, the selection status bar, AutoFilter, and row insertion — and
// checks that saved sources never contain computed formula results.

const savedDocumentSchema = z.object({ source: z.string(), title: z.string() });
const savedSourceSchema = z.object({
	rows: z.array(z.record(z.string(), z.unknown())),
});

const DOCUMENT_URL =
	"http://127.0.0.1:5226/api/spaces/space_product/documents/database_feedback";

const COLUMN_INDEX = { name: 1, price: 2, qty: 3, total: 4 } as const;

function cell(page: Page, row: number, column: keyof typeof COLUMN_INDEX) {
	return page
		.locator(`[data-slot="grid-row"][data-index="${row}"] [role="gridcell"]`)
		.nth(COLUMN_INDEX[column]);
}

function columnTexts(page: Page, column: keyof typeof COLUMN_INDEX) {
	return page
		.locator(
			`[data-slot="grid-row"] [role="gridcell"]:nth-child(${COLUMN_INDEX[column] + 1})`
		)
		.allInnerTexts();
}

test("Space database table behaves like a spreadsheet", async ({ page }) => {
	const errors: string[] = [];
	const savedSources: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));

	await page.route("http://127.0.0.1:5226/api/spaces", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				spaces: [
					{ id: "space_product", name: "Product research", document_count: 1 },
				],
			}),
		})
	);
	await page.route(DOCUMENT_URL, async (route) => {
		if (route.request().method() === "PUT") {
			savedSources.push(
				savedDocumentSchema.parse(route.request().postDataJSON()).source
			);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					result: {
						changed: true,
						duplicate: false,
						revision: 2,
						updated_at: 2,
					},
				}),
			});
			return;
		}
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				id: "database_feedback",
				space_id: "space_product",
				title: "Order sheet",
				source: JSON.stringify({
					columns: [
						{ id: "col_name", label: "Item", cell: { variant: "short-text" } },
						{ id: "col_price", label: "Price", cell: { variant: "number" } },
						{
							id: "col_qty",
							label: "Qty",
							cell: {
								variant: "number",
								formatRules: [
									{
										id: "rule_big",
										operator: "greaterThan",
										value: "5",
										color: "red",
									},
								],
							},
						},
						{
							id: "col_total",
							label: "Total",
							cell: { variant: "formula", expression: "{Price} * {Qty}" },
						},
					],
					rows: [
						{ col_name: "Item 1", col_price: 1, col_qty: 2, col_total: "" },
						{ col_name: "Item 2", col_price: 2, col_qty: 6, col_total: "" },
						{ col_name: "Widget", col_price: 10, col_qty: 1, col_total: "" },
						{ col_name: "Gadget", col_price: 20, col_qty: 8, col_total: "" },
					],
					views: [{ id: "view_table", name: "Table", kind: "table" }],
				}),
				created_at: 1,
				updated_at: 1,
				revision: 1,
				chunk_count: 1,
				kind: "database",
				parent_id: null,
			}),
		});
	});

	await page.goto("/spaces-database-query-proof.html");
	await expect(page.getByLabel("Database title")).toHaveValue("Order sheet");

	// Formula column computes from its inputs; Qty > 5 is highlighted.
	await expect
		.poll(() => columnTexts(page, "total"))
		.toEqual(["2", "12", "10", "160"]);
	await expect(
		page.locator('[data-slot="grid-cell-format"][data-format-color="red"]')
	).toHaveCount(2);

	// Fill handle: drag Price 1, 2 down two rows continues the series.
	await cell(page, 0, "price").click();
	await cell(page, 1, "price").click({ modifiers: ["Shift"] });
	const handle = page.locator('[data-slot="grid-fill-handle"]');
	const handleBox = await handle.boundingBox();
	const targetBox = await cell(page, 3, "price").boundingBox();
	if (!(handleBox && targetBox)) {
		throw new Error("fill handle or target cell is not rendered");
	}
	await page.mouse.move(
		handleBox.x + handleBox.width / 2,
		handleBox.y + handleBox.height / 2
	);
	await page.mouse.down();
	await page.mouse.move(
		targetBox.x + targetBox.width / 2,
		targetBox.y + targetBox.height / 2,
		{
			steps: 8,
		}
	);
	await page.mouse.up();
	await expect
		.poll(() => columnTexts(page, "price"))
		.toEqual(["1", "2", "3", "4"]);
	await expect
		.poll(() => columnTexts(page, "total"))
		.toEqual(["2", "12", "3", "32"]);

	// Status bar sums the selected (filled) range.
	await expect(page.locator('[data-slot="grid-status-bar"]')).toContainText(
		"Sum: 10"
	);

	// One undo reverts the whole fill.
	await page.keyboard.press("Control+z");
	await expect
		.poll(() => columnTexts(page, "price"))
		.toEqual(["1", "2", "10", "20"]);

	// AutoFilter on Item hides a value and reports the filtered count.
	await page
		.getByRole("columnheader")
		.nth(COLUMN_INDEX.name)
		.getByRole("button")
		.click();
	await page.getByRole("menuitem", { name: "Filter" }).hover();
	await page.getByRole("menuitemcheckbox", { name: /^Widget/ }).click();
	await page.keyboard.press("Escape");
	await page.keyboard.press("Escape");
	await expect(page.locator('[data-slot="grid-status-bar"]')).toContainText(
		"Rows: 3 of 4"
	);
	await page
		.getByRole("columnheader")
		.nth(COLUMN_INDEX.name)
		.getByRole("button")
		.click();
	await page.getByRole("menuitem", { name: "Clear filter" }).click();
	await expect(page.locator('[data-slot="grid-status-bar"]')).toContainText(
		"Rows: 4"
	);

	// Insert a row from the context menu, then undo it.
	await cell(page, 1, "name").click({ button: "right" });
	await page.getByRole("menuitem", { name: "Insert row above" }).click();
	await expect(page.locator('[data-slot="grid-row"]')).toHaveCount(5);
	await page.keyboard.press("Control+z");
	await expect(page.locator('[data-slot="grid-row"]')).toHaveCount(4);

	// The property editor adds a highlight rule to an existing column…
	await page
		.getByRole("columnheader")
		.nth(COLUMN_INDEX.qty)
		.getByRole("button")
		.click();
	await page.getByRole("menuitem", { name: "Edit property" }).click();
	const editor = page.getByRole("dialog");
	await editor.getByRole("button", { name: "Add highlight rule" }).click();
	await editor.getByLabel("Condition").nth(1).selectOption("lessThan");
	await editor.getByLabel("Value").nth(1).fill("2");
	await editor.getByRole("button", { name: "Save", exact: true }).click();
	// Qty 6 and 8 match "> 5"; Qty 1 now matches "< 2".
	await expect(
		page.locator('[data-slot="grid-cell-format"][data-format-color="red"]')
	).toHaveCount(3);

	// …and creates a formula column, rejecting an invalid formula first.
	await page.getByRole("button", { name: "Add column", exact: true }).click();
	await editor.getByPlaceholder("Property name").fill("Double");
	await editor.getByRole("button", { name: "Formula", exact: true }).click();
	await editor.getByLabel("Formula").fill("{Price} *");
	await expect(editor.getByText("Formula ends unexpectedly")).toBeVisible();
	await expect(
		editor.getByRole("button", { name: "Add property", exact: true })
	).toBeDisabled();
	await editor.getByLabel("Formula").fill("{Price} * 2");
	await expect(editor.getByText("Formula is valid")).toBeVisible();
	await editor
		.getByRole("button", { name: "Add property", exact: true })
		.click();
	await expect
		.poll(() =>
			page
				.locator('[data-slot="grid-row"] [role="gridcell"]:nth-child(6)')
				.allInnerTexts()
		)
		.toEqual(["2", "4", "20", "40"]);

	// Saves keep formula inputs only — computed results are never persisted.
	await expect
		.poll(() => savedSources.length, { timeout: 10_000 })
		.toBeGreaterThan(0);
	for (const source of savedSources) {
		for (const row of savedSourceSchema.parse(JSON.parse(source)).rows) {
			expect(row.col_total ?? "").toBe("");
			for (const [key, value] of Object.entries(row)) {
				// The new formula column (generated id) is stored empty as well;
				// reserved `__` keys (row identity) are not cell values.
				if (
					!(
						key.startsWith("__") ||
						["col_name", "col_price", "col_qty", "col_total"].includes(key)
					)
				) {
					expect(value ?? "").toBe("");
				}
			}
		}
	}
	expect(errors).toEqual([]);

	const proofPath = path.join(
		import.meta.dirname,
		"../../../docs/proof/spaces-database-excel.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		path: proofPath,
		fullPage: true,
		animations: "disabled",
	});
});
