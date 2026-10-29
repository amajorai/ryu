import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { databaseQueryProofSchema } from "./settings-domain-proof.contracts.ts";

test("Space database query panel runs read-only SQL and renders typed results", async ({
	page,
}) => {
	const errors: string[] = [];
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
	await page.route(
		"http://127.0.0.1:5226/api/spaces/space_product/documents/database_feedback",
		(route) =>
			route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					id: "database_feedback",
					space_id: "space_product",
					title: "Feedback tracker",
					source: JSON.stringify({
						columns: [
							{
								id: "col_task",
								label: "Task Name",
								cell: { variant: "short-text" },
							},
							{
								id: "col_status",
								label: "Status",
								cell: { variant: "short-text" },
							},
						],
						rows: [{ col_task: "Ship query", col_status: "Done" }],
						views: [{ id: "view_table", name: "Table", kind: "table" }],
					}),
					created_at: 1,
					updated_at: 1,
					revision: 1,
					chunk_count: 1,
					kind: "database",
					parent_id: null,
				}),
			})
	);
	await page.route(
		"http://127.0.0.1:5226/api/spaces/space_product/databases/database_feedback/query",
		async (route) => {
			const request = databaseQueryProofSchema.parse(
				route.request().postDataJSON()
			);
			expect(request.query).toContain("SELECT");
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({
					columns: ["task_name", "total"],
					rows: [["Ship query", 1]],
					schema: [
						{ id: "col_task", label: "Task Name", name: "task_name" },
						{ id: "col_status", label: "Status", name: "status" },
					],
					truncated: false,
				}),
			});
		}
	);
	await page.goto("/spaces-database-query-proof.html");
	await expect(page.getByLabel("Database title")).toHaveValue(
		"Feedback tracker"
	);
	await page.getByRole("button", { name: "SQL query", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByText("Query database", { exact: true })
	).toBeVisible();
	await dialog
		.locator("#space-database-query")
		.fill("SELECT task_name, COUNT(*) AS total FROM data GROUP BY task_name");
	await dialog.getByRole("button", { name: "Run query", exact: true }).click();
	await expect(
		dialog.getByRole("cell", { name: "Ship query", exact: true })
	).toBeVisible();
	await expect(
		dialog.getByText("Task Name: task_name", { exact: true })
	).toBeVisible();
	expect(errors).toEqual([]);

	const proofPath = path.join(
		import.meta.dirname,
		"../../../docs/proof/spaces-database-query.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		path: proofPath,
		fullPage: true,
		animations: "disabled",
	});
});
