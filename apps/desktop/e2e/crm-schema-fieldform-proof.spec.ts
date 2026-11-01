import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { Field } from "@/src/lib/api/crm.ts";
import {
	evidenceDir,
	installCrmApi,
	openSchema,
	proofStates,
	screenshotPath,
} from "./crm-schema-fieldform-proof.fixture.ts";

test.beforeEach(({ page }) => {
	const state: Parameters<typeof proofStates.set>[1] = {
		requests: [],
		unexpected: [],
		pageErrors: [],
	};
	proofStates.set(page, state);
	page.on("pageerror", (error) => state.pageErrors.push(error.message));
});
test.afterEach(async ({ page }, info) => {
	const state = proofStates.get(page);
	await mkdir(evidenceDir, { recursive: true });
	await writeFile(
		path.resolve(
			evidenceDir,
			`${info.title.replace(/[^a-z0-9]+/gi, "-")}-contracts.json`
		),
		JSON.stringify(state, null, 2)
	);
	expect(
		state?.unexpected ?? [],
		"all API origin/auth/method/path contracts must match"
	).toEqual([]);
	expect(state?.pageErrors ?? [], "uncaught production page errors").toEqual(
		[]
	);
});

test("creates unique status options, retains a failed draft, retries, and reloads persisted schema", async ({
	page,
}) => {
	const writes = await installCrmApi(page, { failFirstCreate: true });
	await openSchema(page);
	await expect(
		page.getByRole("heading", { name: "Deals schema" })
	).toBeVisible();

	await page.getByRole("button", { name: "Add field", exact: true }).click();
	const fieldName = page.getByLabel("Field name");
	await fieldName.fill("Lead Status");
	await page.getByLabel("Type").selectOption("status");

	const optionDraft = page.getByLabel("New option label");
	await optionDraft.fill("Sales Accepted");
	await optionDraft.press("Enter");
	await page
		.getByRole("button", { name: "Option Sales Accepted colour" })
		.click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#D946EF");
	await page.keyboard.press("Escape");
	await optionDraft.fill("Sales-Accepted");
	await optionDraft.press("Enter");

	const wonOptions = page.getByRole("checkbox", { name: "won", exact: true });
	const lostOptions = page.getByRole("checkbox", { name: "lost", exact: true });
	await expect(wonOptions).toHaveCount(2);
	await expect(lostOptions).toHaveCount(2);
	await wonOptions.nth(0).check();
	await lostOptions.nth(1).check();
	await page.getByRole("checkbox", { name: "Required", exact: true }).check();

	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await expect(
		page.getByText("Temporary CRM write failure", { exact: true })
	).toBeVisible();
	await expect(fieldName).toHaveValue("Lead Status");
	await expect(
		page.getByRole("checkbox", { name: "Required", exact: true })
	).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Add field", exact: true })
	).toBeEnabled();
	await expect(writes).toHaveLength(1);

	const expectedCreateBody: Partial<Field> = {
		config: {
			options: [
				{
					color: "#D946EF",
					id: "sales_accepted",
					is_won: true,
					label: "Sales Accepted",
					position: 0,
				},
				{
					id: "sales_accepted_2",
					is_lost: true,
					label: "Sales-Accepted",
					position: 1,
				},
			],
		},
		field_type: "status",
		is_required: true,
		name: "Lead Status",
		slug: "lead_status",
	};
	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await expect(page.getByText("Lead Status", { exact: true })).toBeVisible();
	await expect(writes).toHaveLength(2);
	await expect(writes[1]).toEqual({
		body: expectedCreateBody,
		method: "POST",
		path: "/api/crm/objects/deal/fields",
	});

	await page.reload();
	await page.getByRole("button", { name: "Edit schema", exact: true }).click();
	await expect(page.getByText("Lead Status", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Sales Accepted · won", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Sales-Accepted · lost", { exact: true })
	).toBeVisible();

	const proofPath = screenshotPath(
		"harness/proof/crm-schema-fieldform-proof.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath,
	});
});

test("cancels drafts and persists currency, relation, and rating configuration", async ({
	page,
}) => {
	const writes = await installCrmApi(page);
	await openSchema(page);

	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await page.getByLabel("Field name").fill("Cancelled field");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(page.getByText("Cancelled field", { exact: true })).toHaveCount(
		0
	);
	await expect(writes).toHaveLength(0);

	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await page.getByLabel("Field name").fill("Annual recurring revenue");
	await page.getByLabel("Type").selectOption("currency");
	await page.getByLabel("Currency code").fill("sgd");
	await page.getByRole("checkbox", { name: "Required", exact: true }).check();
	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await expect(
		page.getByText("Annual recurring revenue", { exact: true })
	).toBeVisible();
	await expect(writes[0]).toEqual({
		body: {
			config: { currency_code: "SGD" },
			field_type: "currency",
			is_required: true,
			name: "Annual recurring revenue",
			slug: "annual_recurring_revenue",
		},
		method: "POST",
		path: "/api/crm/objects/deal/fields",
	});

	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await page.getByLabel("Field name").fill("Primary company");
	await page.getByLabel("Type").selectOption("relation");
	const addRelation = page.getByRole("button", {
		name: "Add field",
		exact: true,
	});
	await expect(addRelation).toBeDisabled();
	await page.getByLabel("Links to").selectOption("obj_company");
	await page.getByRole("checkbox", { name: "Required", exact: true }).check();
	await expect(addRelation).toBeEnabled();
	await addRelation.click();
	await expect(
		page.getByText("Primary company", { exact: true })
	).toBeVisible();
	await expect(writes[1]).toEqual({
		body: {
			config: { relation_object_id: "obj_company" },
			field_type: "relation",
			is_required: true,
			name: "Primary company",
			slug: "primary_company",
		},
		method: "POST",
		path: "/api/crm/objects/deal/fields",
	});

	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await page.getByLabel("Field name").fill("Customer confidence");
	await page.getByLabel("Type").selectOption("rating");
	await page.getByLabel("Out of").fill("7");
	await page.getByRole("button", { name: "Add field", exact: true }).click();
	await expect(
		page.getByText("Customer confidence", { exact: true })
	).toBeVisible();
	await expect(writes[2]).toEqual({
		body: {
			config: { max_rating: 7 },
			field_type: "rating",
			is_required: false,
			name: "Customer confidence",
			slug: "customer_confidence",
		},
		method: "POST",
		path: "/api/crm/objects/deal/fields",
	});

	await page.reload();
	await page.getByRole("button", { name: "Edit schema", exact: true }).click();
	await expect(
		page.getByText("Annual recurring revenue", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Primary company", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Customer confidence", { exact: true })
	).toBeVisible();
});

test("edits an existing select field, warns before option removal, and persists the update", async ({
	page,
}) => {
	const writes = await installCrmApi(page);
	await openSchema(page);

	const sourceField = page.getByRole("listitem").filter({ hasText: "Source" });
	await sourceField.getByRole("button", { name: "Edit", exact: true }).click();
	await expect(page.getByLabel("Type")).toBeDisabled();
	await page.getByLabel("Field name").fill("Lead source");
	await page
		.getByRole("textbox", { name: "Option 2 label" })
		.fill("Referral network");
	await page
		.getByRole("button", {
			name: "Option Referral network colour",
			exact: true,
		})
		.click();
	await page.getByRole("textbox", { name: "Hex color value" }).fill("#123456");
	await page.keyboard.press("Escape");
	await page
		.getByRole("button", { name: "Remove option Event", exact: true })
		.click();
	await expect(
		page.getByText("Removing Event affects records that still hold it.", {
			exact: true,
		})
	).toBeVisible();
	const optionDraft = page.getByLabel("New option label");
	await optionDraft.fill("Partner Referral");
	await optionDraft.press("Enter");
	await page.getByRole("checkbox", { name: "Required", exact: true }).check();
	await page.getByRole("button", { name: "Save", exact: true }).click();

	await expect(page.getByText("Lead source", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Referral network", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Partner Referral", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Event", { exact: true })).toHaveCount(0);
	await expect(writes).toHaveLength(1);
	await expect(writes[0]).toEqual({
		body: {
			config: {
				options: [
					{
						color: "#123456",
						id: "referral",
						label: "Referral network",
						position: 0,
					},
					{ id: "partner_referral", label: "Partner Referral", position: 1 },
				],
			},
			field_type: "select",
			is_required: true,
			name: "Lead source",
			slug: "source",
		},
		method: "PATCH",
		path: "/api/crm/fields/fld_source",
	});

	await page.reload();
	await page.getByRole("button", { name: "Edit schema", exact: true }).click();
	await expect(page.getByText("Lead source", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Referral network", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Partner Referral", { exact: true })
	).toBeVisible();
	await expect(page.getByText("Event", { exact: true })).toHaveCount(0);

	const proofPath = screenshotPath(
		"harness/proof/crm-schema-fieldform-edit-proof.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: proofPath,
	});
});

test("production schema actions reorder fields, retain denied edit drafts, and retry deletion with protected system fields", async ({
	page,
}) => {
	const writes = await installCrmApi(page);
	await openSchema(page);
	await expect(
		page.getByRole("button", { name: "Move Deal name up" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Move Source down" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Delete Deal name", exact: true })
	).toHaveCount(0);
	writes.fail("POST", "/api/crm/objects/deal/fields/reorder");
	await page.getByRole("button", { name: "Move Stage down" }).click();
	await expect(
		page.getByText("Temporary schema request failure")
	).toBeVisible();
	expect(
		writes.schema.objects[0]?.fields.find((field) => field.id === "fld_stage")
			?.position
	).toBe(1);
	await page.getByRole("button", { name: "Move Stage down" }).click();
	await expect(
		page.getByRole("button", { name: "Move Stage down" })
	).toBeDisabled();
	expect(writes.at(-1)?.body).toEqual({
		ids: ["fld_title", "fld_source", "fld_stage"],
	});
	await page.getByRole("button", { name: "Move Stage up" }).click();
	await expect(
		page.getByRole("button", { name: "Move Source down" })
	).toBeDisabled();
	expect(writes.at(-1)?.body).toEqual({
		ids: ["fld_title", "fld_stage", "fld_source"],
	});
	const source = page.getByRole("listitem").filter({
		has: page.getByRole("button", { name: "Delete Source", exact: true }),
	});
	await source.getByRole("button", { name: "Edit", exact: true }).click();
	await page.getByLabel("Field name").fill("Referred by");
	await page.getByRole("checkbox", { name: "Required", exact: true }).check();
	writes.fail("PATCH", "/api/crm/fields/fld_source", 403);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByText("Schema changes are not permitted.")
	).toBeVisible();
	await expect(page.getByLabel("Field name")).toHaveValue("Referred by");
	await expect(page.getByLabel("Type")).toBeDisabled();
	expect(
		writes.schema.objects[0]?.fields.find((field) => field.id === "fld_source")
			?.name
	).toBe("Source");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Delete Referred by", exact: true })
	).toBeVisible();
	await expect(page.getByText("Schema changes are not permitted.")).toHaveCount(
		0
	);
	expect(writes.at(-1)?.body).toMatchObject({
		field_type: "select",
		is_required: true,
		name: "Referred by",
		slug: "source",
	});
	writes.fail("DELETE", "/api/crm/fields/fld_source", 403);
	await page
		.getByRole("button", { name: "Delete Referred by", exact: true })
		.click();
	await expect(
		page.getByText("Schema changes are not permitted.")
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Delete Referred by", exact: true })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Delete Referred by", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Delete Referred by", exact: true })
	).toHaveCount(0);
	await page.reload();
	await page.getByRole("button", { name: "Edit schema", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Delete Referred by", exact: true })
	).toHaveCount(0);
	await expect(page.getByText("Deal name", { exact: true })).toBeVisible();
});

test("object form validates and cancels, retains a denied draft, persists creation and returns to an existing schema after deletion", async ({
	page,
}) => {
	const writes = await installCrmApi(page);
	await openSchema(page);
	await expect(
		page.getByRole("button", { name: "Delete the Deal object", exact: true })
	).toHaveCount(0);
	await page.getByRole("button", { name: "New object", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Create", exact: true })
	).toBeDisabled();
	await page.getByLabel("Name (one)").fill("Canceled object");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	expect(writes).toHaveLength(0);
	await page.getByRole("button", { name: "New object", exact: true }).click();
	await page.getByLabel("Name (one)").fill(" Investor ");
	await page.getByLabel("Name (many)").fill(" Investors ");
	writes.fail("POST", "/api/crm/objects", 403);
	await page.getByRole("button", { name: "Create", exact: true }).click();
	await expect(
		page.getByText("Schema changes are not permitted.")
	).toBeVisible();
	await expect(page.getByLabel("Name (one)")).toHaveValue(" Investor ");
	await expect(page.getByLabel("Name (many)")).toHaveValue(" Investors ");
	expect(writes.at(-1)?.body).toEqual({
		singular: "Investor",
		plural: "Investors",
		slug: "investor",
	});
	await page.getByRole("button", { name: "Create", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Investors 0", exact: true })
	).toBeVisible();
	await page.reload();
	await page.getByRole("button", { name: "Investors 0", exact: true }).click();
	await page.getByRole("button", { name: "Edit schema", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Investors schema" })
	).toBeVisible();
	writes.fail("DELETE", "/api/crm/objects/investor", 403);
	await page
		.getByRole("button", { name: "Delete the Investor object", exact: true })
		.click();
	await expect(
		page.getByText("Schema changes are not permitted.")
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Investors schema" })
	).toBeVisible();
	await page
		.getByRole("button", { name: "Delete the Investor object", exact: true })
		.click();
	await expect(
		page.getByRole("button", { name: "Investors 0", exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("heading", { name: "Deals schema" })
	).toBeVisible();
	expect(
		writes.filter(
			(write) =>
				write.method === "DELETE" && write.path === "/api/crm/objects/investor"
		)
	).toHaveLength(2);
	const proofPath = screenshotPath(
		"../../../docs/proof/test-coverage-sweep-20260924/evidence/desktop-crm-schema-object-delete-readback.png"
	);
	await mkdir(path.dirname(proofPath), { recursive: true });
	await page.screenshot({ animations: "disabled", path: proofPath });
});
