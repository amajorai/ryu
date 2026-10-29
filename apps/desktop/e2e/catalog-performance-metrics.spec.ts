import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";

const catalogMetricsSchema = z.object({
	catalogReads: z.number(),
	polls: z.number(),
	saves: z.number(),
});

test("measures cold catalog fan-out and warm workspace reuse", async ({
	page,
	request,
}) => {
	await request.get("/proof-reset");
	await page.goto("/catalog-performance-proof.html");
	await expect(page.getByTestId("app-state")).toHaveText(
		Array.from({ length: 8 }, () => "alpha Notes: Disabled"),
		{ timeout: 30_000 }
	);
	const cold = catalogMetricsSchema.parse(
		await (await request.get("/proof-metrics")).json()
	).catalogReads;
	await page
		.getByRole("button", { name: "Add workspace", exact: true })
		.click();
	await expect(page.getByTestId("app-state")).toHaveText(
		Array.from({ length: 9 }, () => "alpha Notes: Disabled")
	);
	const warm =
		catalogMetricsSchema.parse(
			await (await request.get("/proof-metrics")).json()
		).catalogReads - cold;
	const baseline = Boolean(process.env.RYU_PERF_BASELINE);
	expect(cold).toBe(baseline ? 32 : 4);
	expect(warm).toBe(baseline ? 4 : 0);
	const directory = path.resolve(
		import.meta.dirname,
		"../../../docs/proof/performance-sweep"
	);
	await mkdir(directory, { recursive: true });
	await writeFile(
		path.join(
			directory,
			baseline ? "catalog-before.json" : "catalog-after.json"
		),
		`${JSON.stringify(
			{
				scenario:
					"8 mounted consumers; then one new workspace; real hooks against controlled local API",
				coldReads: cold,
				warmReads: warm,
			},
			null,
			2
		)}\n`
	);
});
