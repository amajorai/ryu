import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	type PluginDocument,
	pluginDocumentSchema,
} from "../src/lib/api/plugin-wire-values.ts";

const grantsRequestFieldsSchema = z.object({ grants: z.array(z.string()) });
const grantsRequestSchema = z.custom<
	z.output<typeof grantsRequestFieldsSchema> & PluginDocument
>(
	(value) =>
		pluginDocumentSchema.safeParse(value).success &&
		grantsRequestFieldsSchema.safeParse(value).success
);

test("optional administrative access starts off and changes only after explicit consent", async ({
	page,
}) => {
	const proof = path.resolve(
		process.cwd(),
		"../../docs/proof/security-optional-audit-2026-10-04"
	);
	mkdirSync(proof, { recursive: true });
	let grants = ["usage:read"];
	const requests: PluginDocument[] = [];
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.route("**/proof/grants", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ grants }),
		})
	);
	await page.route("**/api/plugins/**/grants", async (route) => {
		const parsedBody = grantsRequestSchema.safeParse(
			route.request().postDataJSON()
		);
		if (!parsedBody.success) {
			throw new Error("Grant request must contain string grants");
		}
		const body = parsedBody.data;
		requests.push(body);
		grants = body.grants;
		await route.fulfill({
			contentType: "application/json",
			body: JSON.stringify({ approved_grants: grants }),
		});
	});
	await page.goto("/optional-grants-proof.html", {
		waitUntil: "domcontentloaded",
	});
	const audit = page.getByRole("switch", {
		name: /administrative audit records/,
	});
	await expect(audit).not.toBeChecked();
	await expect(page.getByText("Optional", { exact: true })).toBeVisible();
	await expect(page.getByText(/Editing remains available/)).toBeVisible();
	expect(requests).toHaveLength(0);
	await page.screenshot({
		path: path.join(proof, "audit-off.png"),
		fullPage: true,
	});
	await audit.click();
	await expect(audit).toBeChecked();
	expect(requests).toEqual([{ grants: ["usage:read", "usage:audit"] }]);
	await page.screenshot({
		path: path.join(proof, "audit-approved.png"),
		fullPage: true,
	});
	await audit.click();
	await expect(audit).not.toBeChecked();
	expect(grants).toEqual(["usage:read"]);
	expect(errors).toEqual([]);
	writeFileSync(
		path.join(proof, "browser-log.json"),
		JSON.stringify({ requests, errors }, null, 2)
	);
});
