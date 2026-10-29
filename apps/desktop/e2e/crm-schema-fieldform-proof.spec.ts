import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type {
	CrmObject,
	Field,
	ObjectWithFields,
	SchemaResponse,
} from "@/src/lib/api/crm.ts";

const PROOF_PAGE = "/crm-schema-fieldform-proof.html";
const TIMESTAMP = "2026-10-01T00:00:00.000Z";

interface CapturedWrite {
	body: unknown;
	method: string;
	path: string;
}

interface CapturedRequest extends CapturedWrite {
	auth: string | null;
	origin: string;
	status: number;
}

const evidenceDir =
	process.env.RYU_CRM_SCHEMA_FIELDFORM_PROOF_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);
function screenshotPath(defaultRelativePath: string): string {
	return process.env.RYU_CRM_SCHEMA_FIELDFORM_PROOF_DIR
		? path.resolve(evidenceDir, path.basename(defaultRelativePath))
		: path.resolve(import.meta.dirname, defaultRelativePath);
}
const proofStates = new WeakMap<
	Page,
	{
		requests: CapturedRequest[];
		unexpected: string[];
		pageErrors: string[];
	}
>();
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

interface CrmRouteOptions {
	failFirstCreate?: boolean;
}

function makeCrmObject({
	id,
	plural,
	singular,
	slug,
}: Pick<CrmObject, "id" | "plural" | "singular" | "slug">): CrmObject {
	return {
		created_at: TIMESTAMP,
		id,
		is_standard: true,
		plural,
		position: 0,
		singular,
		slug,
		updated_at: TIMESTAMP,
	};
}

function makeField({
	config = {},
	fieldType,
	id,
	isRequired = false,
	isSystem = false,
	name,
	objectId = "obj_deal",
	position,
	slug,
}: {
	config?: Field["config"];
	fieldType: Field["field_type"];
	id: string;
	isRequired?: boolean;
	isSystem?: boolean;
	name: string;
	objectId?: string;
	position: number;
	slug: string;
}): Field {
	return {
		config,
		created_at: TIMESTAMP,
		field_type: fieldType,
		id,
		is_required: isRequired,
		is_system: isSystem,
		is_unique: false,
		name,
		object_id: objectId,
		position,
		slug,
		updated_at: TIMESTAMP,
	};
}

function makeSchema(): SchemaResponse {
	const deal: ObjectWithFields = {
		fields: [
			makeField({
				fieldType: "text",
				id: "fld_title",
				isRequired: true,
				isSystem: true,
				name: "Deal name",
				position: 0,
				slug: "title",
			}),
			makeField({
				config: {
					options: [
						{
							color: "#336699",
							id: "prospecting",
							label: "Prospecting",
							position: 0,
						},
						{
							color: "#445566",
							id: "discovery",
							label: "Discovery",
							position: 1,
						},
					],
				},
				fieldType: "status",
				id: "fld_stage",
				name: "Stage",
				position: 1,
				slug: "stage",
			}),
			makeField({
				config: {
					options: [
						{ color: "#778899", id: "event", label: "Event", position: 0 },
						{
							color: "#485A6B",
							id: "referral",
							label: "Referral",
							position: 1,
						},
					],
				},
				fieldType: "select",
				id: "fld_source",
				name: "Source",
				position: 2,
				slug: "source",
			}),
		],
		object: makeCrmObject({
			id: "obj_deal",
			plural: "Deals",
			singular: "Deal",
			slug: "deal",
		}),
		record_count: 3,
		views: [],
	};
	const company: ObjectWithFields = {
		fields: [],
		object: makeCrmObject({
			id: "obj_company",
			plural: "Companies",
			singular: "Company",
			slug: "company",
		}),
		record_count: 1,
		views: [],
	};

	return { lists: [], objects: [deal, company] };
}

async function installCrmApi(
	page: Page,
	{ failFirstCreate = false }: CrmRouteOptions = {}
): Promise<
	CapturedWrite[] & {
		schema: SchemaResponse;
		fail: (method: string, path: string, status?: number) => void;
	}
> {
	const schema = makeSchema();
	const writes: CapturedWrite[] = [];
	let shouldFailCreate = failFirstCreate;
	const failures = new Map<string, number>();

	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const { pathname } = url;
			const method = request.method();
			const state = proofStates.get(page);
			if (!state) {
				throw new Error("CRM schema proof state missing");
			}
			const body = request.postData() ? request.postDataJSON() : null;
			const captured: CapturedRequest = {
				auth: request.headers().authorization ?? null,
				body,
				method,
				origin: url.origin,
				path: `${pathname}${url.search}`,
				status: 0,
			};
			state.requests.push(captured);
			const fulfill: typeof route.fulfill = async (options) => {
				captured.status = options?.status ?? 200;
				await route.fulfill(options);
			};
			const objectPath = pathname.match(/^\/api\/crm\/objects\/([^/]+)$/);
			const queryPath = pathname.match(
				/^\/api\/crm\/objects\/([^/]+)\/records\/query$/
			);
			const fieldPath = pathname.match(/^\/api\/crm\/fields\/([^/]+)$/);
			const known =
				url.search === "" &&
				((method === "GET" && pathname === "/api/crm/schema") ||
					(method === "POST" &&
						[
							"/api/crm/objects",
							"/api/crm/objects/deal/fields",
							"/api/crm/objects/deal/fields/reorder",
						].includes(pathname)) ||
					(method === "POST" &&
						queryPath !== null &&
						schema.objects.some(
							(entry) => entry.object.slug === queryPath[1]
						)) ||
					(method === "DELETE" &&
						objectPath !== null &&
						schema.objects.some(
							(entry) => entry.object.slug === objectPath[1]
						)) ||
					(["PATCH", "DELETE"].includes(method) &&
						fieldPath !== null &&
						schema.objects.some((entry) =>
							entry.fields.some((field) => field.id === fieldPath[1])
						)));
			if (
				!known ||
				url.origin !== "http://127.0.0.1:5333" ||
				captured.auth !== "Bearer crm-table-proof-node-token" ||
				(["GET", "DELETE"].includes(method) && body !== null)
			) {
				state.unexpected.push(
					`${method} ${url.origin}${captured.path}: ${known ? (url.origin === "http://127.0.0.1:5333" ? (captured.auth === "Bearer crm-table-proof-node-token" ? "unexpected body" : "wrong node authorization") : "wrong node origin") : "unknown API"}`
				);
				await fulfill({
					status: 501,
					contentType: "application/json",
					body: JSON.stringify({
						error: "CRM schema transport contract refused",
					}),
				});
				return;
			}
			const deal = schema.objects.find((entry) => entry.object.slug === "deal");
			const failure = failures.get(`${method} ${pathname}`);
			if (failure) {
				failures.delete(`${method} ${pathname}`);
				writes.push({
					method,
					path: pathname,
					body: request.postData() ? request.postDataJSON() : null,
				});
				await fulfill({
					status: failure,
					contentType: "application/json",
					body: JSON.stringify({
						error:
							failure === 403
								? "Schema changes are not permitted."
								: "Temporary schema request failure",
					}),
				});
				return;
			}
			if (method === "POST" && pathname === "/api/crm/objects") {
				const body = request.postDataJSON();
				writes.push({ method, path: pathname, body });
				const object = {
					...makeCrmObject({ ...body, id: `obj_${body.slug}` }),
					is_standard: false,
				};
				schema.objects.push({ object, fields: [], views: [], record_count: 0 });
				await fulfill({
					status: 201,
					contentType: "application/json",
					body: JSON.stringify(object),
				});
				return;
			}
			if (method === "DELETE" && pathname.startsWith("/api/crm/objects/")) {
				writes.push({ method, path: pathname, body: null });
				schema.objects = schema.objects.filter(
					(entry) => `/api/crm/objects/${entry.object.slug}` !== pathname
				);
				await fulfill({ status: 204 });
				return;
			}
			if (method === "DELETE" && pathname.startsWith("/api/crm/fields/")) {
				writes.push({ method, path: pathname, body: null });
				if (deal) {
					deal.fields = deal.fields.filter(
						(field) => `/api/crm/fields/${field.id}` !== pathname
					);
				}
				await fulfill({ status: 204 });
				return;
			}
			if (
				method === "POST" &&
				pathname === "/api/crm/objects/deal/fields/reorder"
			) {
				const body = request.postDataJSON();
				writes.push({ method, path: pathname, body });
				for (const [position, id] of body.field_ids.entries()) {
					const field = deal?.fields.find((candidate) => candidate.id === id);
					if (field) {
						field.position = position;
					}
				}
				await fulfill({ status: 204 });
				return;
			}

			if (method === "POST" && pathname.endsWith("/records/query")) {
				await fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ items: [], total: 0, has_more: false }),
				});
				return;
			}

			if (method === "GET" && pathname === "/api/crm/schema") {
				await fulfill({
					body: JSON.stringify(schema),
					contentType: "application/json",
					status: 200,
				});
				return;
			}

			if (method === "POST" && pathname === "/api/crm/objects/deal/fields") {
				const body = request.postDataJSON();
				writes.push({ body: structuredClone(body), method, path: pathname });
				if (shouldFailCreate) {
					shouldFailCreate = false;
					await fulfill({
						body: JSON.stringify({ error: "Temporary CRM write failure" }),
						contentType: "application/json",
						status: 503,
					});
					return;
				}

				if (!deal) {
					throw new Error("Deal fixture missing from CRM proof schema");
				}
				const field: Field = {
					config: body.config ?? {},
					created_at: TIMESTAMP,
					field_type: body.field_type ?? "text",
					id: `fld_${body.slug ?? "new"}`,
					is_required: body.is_required ?? false,
					is_system: false,
					is_unique: false,
					name: body.name ?? "New field",
					object_id: deal.object.id,
					position: deal.fields.length,
					slug: body.slug ?? "new",
					updated_at: TIMESTAMP,
				};
				deal.fields.push(field);
				await fulfill({
					body: JSON.stringify(field),
					contentType: "application/json",
					status: 201,
				});
				return;
			}

			if (method === "PATCH" && pathname.startsWith("/api/crm/fields/")) {
				const body = request.postDataJSON();
				writes.push({ body: structuredClone(body), method, path: pathname });
				if (!deal) {
					throw new Error("Deal fixture missing from CRM proof schema");
				}
				const index = deal.fields.findIndex(
					(field) => `/api/crm/fields/${field.id}` === pathname
				);
				if (index < 0) {
					await fulfill({
						body: JSON.stringify({ error: "Field not found" }),
						contentType: "application/json",
						status: 404,
					});
					return;
				}

				const current = deal.fields[index];
				if (!current) {
					throw new Error("CRM proof field disappeared during update");
				}
				const updated: Field = {
					...current,
					...body,
					config: body.config ?? current.config,
					updated_at: TIMESTAMP,
				};
				deal.fields[index] = updated;
				await fulfill({
					body: JSON.stringify(updated),
					contentType: "application/json",
					status: 200,
				});
				return;
			}

			state.unexpected.push(`${method} ${pathname}: missing explicit response`);
			await fulfill({
				body: JSON.stringify({
					error: `Unexpected CRM proof request: ${method} ${pathname}`,
				}),
				contentType: "application/json",
				status: 404,
			});
		}
	);

	return Object.assign(writes, {
		schema,
		fail: (method: string, path: string, status = 503) => {
			failures.set(`${method} ${path}`, status);
		},
	});
}

async function openSchema(page: Page): Promise<void> {
	await page.goto(PROOF_PAGE);
	await page.getByRole("button", { name: "Edit schema", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Deals schema" })
	).toBeVisible();
}

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
		field_ids: ["fld_title", "fld_source", "fld_stage"],
	});
	await page.getByRole("button", { name: "Move Stage up" }).click();
	await expect(
		page.getByRole("button", { name: "Move Source down" })
	).toBeDisabled();
	expect(writes.at(-1)?.body).toEqual({
		field_ids: ["fld_title", "fld_stage", "fld_source"],
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
