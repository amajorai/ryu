import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";
import type {
	Activity,
	CrmObject,
	CrmRecord,
	Field,
	ObjectWithFields,
	RelatedGroup,
	SchemaResponse,
	View,
} from "@/src/lib/api/crm.ts";

const PROOF_PAGE = "/crm-record-detail-proof.html";
const TIMESTAMP = "2026-10-01T00:00:00.000Z";
const DEAL_ID = "deal_1";

interface CapturedRequest {
	auth: string | null;
	body: unknown;
	method: string;
	origin: string;
	path: string;
	status: number;
}

interface CrmProofFixture {
	activities: Activity[];
	failNext: (method: string, path: string, status?: number) => void;
	readRecord: (id: string) => CrmRecord | undefined;
	readRelated: () => RelatedGroup[];
	requests: CapturedRequest[];
	unexpected: string[];
}

interface CrmFixtureOptions {
	linkedCompanyDeleted?: boolean;
}

const evidenceDir =
	process.env.RYU_CRM_RECORD_DETAIL_PROOF_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);
const proofStates = new WeakMap<
	Page,
	{ fixture?: CrmProofFixture; pageErrors: string[] }
>();

test.beforeEach(({ page }) => {
	const state: Parameters<typeof proofStates.set>[1] = { pageErrors: [] };
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
		JSON.stringify(
			{
				requests: state?.fixture?.requests ?? [],
				unexpected: state?.fixture?.unexpected ?? [],
				pageErrors: state?.pageErrors ?? [],
			},
			null,
			2
		)
	);
	expect(
		state?.fixture?.unexpected ?? [],
		"all API origin/auth/method/path contracts must be known"
	).toEqual([]);
	expect(state?.pageErrors ?? [], "uncaught production page errors").toEqual(
		[]
	);
});

function evidencePath(name: string): string {
	return path.resolve(evidenceDir, `${name}.png`);
}

function makeObject({
	id,
	plural,
	singular,
	slug,
	titleFieldId,
}: Pick<CrmObject, "id" | "plural" | "singular" | "slug"> & {
	titleFieldId: string;
}): CrmObject {
	return {
		created_at: TIMESTAMP,
		id,
		is_standard: true,
		plural,
		position: 0,
		singular,
		slug,
		title_field_id: titleFieldId,
		updated_at: TIMESTAMP,
	};
}

function makeField({
	fieldType,
	id,
	isSystem = false,
	name,
	objectId,
	position,
	slug,
}: {
	fieldType: Field["field_type"];
	id: string;
	isSystem?: boolean;
	name: string;
	objectId: string;
	position: number;
	slug: string;
}): Field {
	return {
		created_at: TIMESTAMP,
		field_type: fieldType,
		id,
		is_required: false,
		is_system: isSystem,
		is_unique: false,
		name,
		object_id: objectId,
		position,
		slug,
		updated_at: TIMESTAMP,
	};
}

function makeActivity({
	completedAt = null,
	id,
	kind,
	title,
}: {
	completedAt?: string | null;
	id: string;
	kind: Activity["kind"];
	title: string;
}): Activity {
	return {
		completed_at: completedAt,
		created_at: TIMESTAMP,
		id,
		kind,
		record_id: DEAL_ID,
		title,
		updated_at: TIMESTAMP,
	};
}

function makeFixtureSchema(): SchemaResponse {
	const dealTitle = makeField({
		fieldType: "text",
		id: "fld_deal_title",
		isSystem: true,
		name: "Deal name",
		objectId: "obj_deal",
		position: 0,
		slug: "title",
	});
	const amount = makeField({
		fieldType: "number",
		id: "fld_amount",
		name: "Amount",
		objectId: "obj_deal",
		position: 1,
		slug: "amount",
	});
	const companyLink = makeField({
		fieldType: "relation",
		id: "fld_company",
		name: "Company",
		objectId: "obj_deal",
		position: 2,
		slug: "company",
	});
	const companyTitle = makeField({
		fieldType: "text",
		id: "fld_company_title",
		isSystem: true,
		name: "Company name",
		objectId: "obj_company",
		position: 0,
		slug: "title",
	});
	const companyWebsite = makeField({
		fieldType: "url",
		id: "fld_company_website",
		name: "Website",
		objectId: "obj_company",
		position: 1,
		slug: "website",
	});
	const defaultView: View = {
		created_at: TIMESTAMP,
		filter: null,
		id: "view_deals",
		is_default: true,
		kind: "table",
		name: "All deals",
		object_id: "obj_deal",
		position: 0,
		sorts: [],
		updated_at: TIMESTAMP,
		visible_field_ids: [amount.id, companyLink.id],
	};
	const deal: ObjectWithFields = {
		fields: [dealTitle, amount, companyLink],
		object: makeObject({
			id: "obj_deal",
			plural: "Deals",
			singular: "Deal",
			slug: "deal",
			titleFieldId: dealTitle.id,
		}),
		record_count: 1,
		views: [defaultView],
	};
	const company: ObjectWithFields = {
		fields: [companyTitle, companyWebsite],
		object: makeObject({
			id: "obj_company",
			plural: "Companies",
			singular: "Company",
			slug: "company",
			titleFieldId: companyTitle.id,
		}),
		record_count: 2,
		views: [],
	};
	return { lists: [], objects: [deal, company] };
}

async function installCrmApi(
	page: Page,
	{ linkedCompanyDeleted = false }: CrmFixtureOptions = {}
): Promise<CrmProofFixture> {
	const schema = makeFixtureSchema();
	const recordStore = new Map<string, CrmRecord>([
		[
			DEAL_ID,
			{
				created_at: TIMESTAMP,
				id: DEAL_ID,
				object_id: "obj_deal",
				title: "Renewal Acme",
				updated_at: TIMESTAMP,
				values: { amount: 12_000, company: null, title: "Renewal Acme" },
			},
		],
		[
			"company_1",
			{
				created_at: TIMESTAMP,
				deleted_at: linkedCompanyDeleted ? TIMESTAMP : null,
				id: "company_1",
				object_id: "obj_company",
				title: "Acme",
				updated_at: TIMESTAMP,
				values: { title: "Acme", website: "https://acme.example" },
			},
		],
		[
			"company_2",
			{
				created_at: TIMESTAMP,
				id: "company_2",
				object_id: "obj_company",
				title: "Globex",
				updated_at: TIMESTAMP,
				values: { title: "Globex", website: "https://globex.example" },
			},
		],
	]);
	const companyRecords = [
		recordStore.get("company_1"),
		recordStore.get("company_2"),
	].filter((record): record is CrmRecord => record !== undefined);
	const relatedGroups: RelatedGroup[] = [
		{
			field_id: "fld_company",
			field_name: "Company",
			object_slug: "company",
			// SAFETY: The authored recordStore immediately above contains company_1 and company_2 before this filtered lookup array is built, so its first cloned entry is a complete native CrmRecord seed.
			records: [structuredClone(companyRecords[0] as CrmRecord)],
		},
	];
	const activities: Activity[] = [
		{
			...makeActivity({
				id: "note_kickoff",
				kind: "note",
				title: "Kickoff notes",
			}),
			body: "Confirm pricing with Acme.",
		},
		makeActivity({ id: "task_proposal", kind: "task", title: "Send proposal" }),
		{
			...makeActivity({
				id: "audit_initial",
				kind: "field_change",
				title: "",
			}),
			field_id: "fld_amount",
			from_value: 10_000,
			to_value: 12_000,
		},
	];
	const requests: CapturedRequest[] = [];
	const unexpected: string[] = [];
	const failures = new Map<string, number[]>();
	const failNext = (method: string, requestPath: string, status = 503) => {
		const key = `${method} ${requestPath}`;
		failures.set(key, [...(failures.get(key) ?? []), status]);
	};

	await page.route(
		(url) => url.pathname.startsWith("/api/"),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const method = request.method();
			const requestPath = `${url.pathname}${url.search}`;
			const rawBody = request.postData();
			const body = rawBody ? request.postDataJSON() : null;
			const captured: CapturedRequest = {
				auth: request.headers().authorization ?? null,
				body: body === null ? null : structuredClone(body),
				method,
				origin: url.origin,
				path: requestPath,
				status: 0,
			};
			requests.push(captured);
			const recordRoute = url.pathname.match(
				/^\/api\/crm\/records\/([^/]+)(?:\/(related|activities))?$/
			);
			const activityRoute = url.pathname.match(
				/^\/api\/crm\/activities\/([^/]+)(\/complete)?$/
			);
			const known =
				(method === "GET" && requestPath === "/api/crm/schema") ||
				(method === "POST" &&
					[
						"/api/crm/objects/deal/records/query",
						"/api/crm/objects/company/records/query",
						"/api/crm/activities",
						"/api/crm/records/company_1/restore",
						"/api/crm/records/deal_1/links",
						"/api/crm/records/deal_1/unlink",
					].includes(requestPath)) ||
				(method === "PATCH" && requestPath === "/api/crm/records/deal_1") ||
				(method === "GET" &&
					recordRoute !== null &&
					recordStore.has(recordRoute[1]) &&
					url.search ===
						(recordRoute[2] === "activities" ? "?limit=100" : "")) ||
				(activityRoute !== null &&
					url.search === "" &&
					activities.some((activity) => activity.id === activityRoute[1]) &&
					((method === "DELETE" && !activityRoute[2]) ||
						(method === "POST" && activityRoute[2] === "/complete")));
			// The retained node seam intentionally has null token/userJwt. The real
			// CRM client therefore uses the proof origin and sends no Authorization.
			if (
				!known ||
				url.origin !== "http://127.0.0.1:5299" ||
				captured.auth !== null ||
				((["GET", "DELETE"].includes(method) ||
					requestPath === "/api/crm/records/company_1/restore") &&
					body !== null)
			) {
				unexpected.push(
					`${method} ${url.origin}${requestPath}: ${known ? (url.origin === "http://127.0.0.1:5299" ? (captured.auth === null ? "unexpected body" : "unexpected authorization") : "wrong node origin") : "unknown API"}`
				);
				captured.status = 501;
				await route.fulfill({
					status: 501,
					contentType: "application/json",
					body: JSON.stringify({
						error: "CRM fixture transport contract refused",
					}),
				});
				return;
			}
			const failureKey = `${method} ${requestPath}`;
			const pendingFailures = failures.get(failureKey);
			if (pendingFailures && pendingFailures.length > 0) {
				const status = pendingFailures.shift() ?? 503;
				if (pendingFailures.length === 0) {
					failures.delete(failureKey);
				}
				captured.status = status;
				await route.fulfill({
					body: JSON.stringify({ error: "Temporary CRM request failure" }),
					contentType: "application/json",
					status,
				});
				return;
			}

			const json = async <FixturePayload>(
				status: number,
				payload: FixturePayload
			) => {
				captured.status = status;
				await route.fulfill({
					body: JSON.stringify(payload),
					contentType: "application/json",
					status,
				});
			};
			const empty = async () => {
				captured.status = 204;
				await route.fulfill({ status: 204 });
			};
			const record = recordStore.get(DEAL_ID);

			if (method === "GET" && requestPath === "/api/crm/schema") {
				await json(200, schema);
				return;
			}
			if (
				method === "POST" &&
				url.pathname === "/api/crm/objects/deal/records/query"
			) {
				await json(200, {
					has_more: false,
					items: record ? [record] : [],
					limit: 50,
					offset: 0,
					total: record ? 1 : 0,
				});
				return;
			}
			if (
				method === "POST" &&
				url.pathname === "/api/crm/objects/company/records/query"
			) {
				// SAFETY: This controlled company lookup is published by mounted RecordDetail RelationPicker, which derives a trimmed native input string and sends { limit: 6, search: needle } through the real CRM JSON serializer; forged requests are outside this fixture.
				const query = body as { search?: string };
				const needle = query.search?.toLowerCase() ?? "";
				const matches = companyRecords.filter((candidate) =>
					candidate.title.toLowerCase().includes(needle)
				);
				await json(200, {
					has_more: false,
					items: matches,
					limit: 6,
					offset: 0,
					total: matches.length,
				});
				return;
			}
			if (method === "GET" && url.pathname === `/api/crm/records/${DEAL_ID}`) {
				await json(record ? 200 : 404, record ?? { error: "Record not found" });
				return;
			}
			if (method === "GET" && url.pathname === "/api/crm/records/company_1") {
				await json(200, recordStore.get("company_1"));
				return;
			}
			if (method === "GET" && url.pathname === "/api/crm/records/company_2") {
				await json(200, recordStore.get("company_2"));
				return;
			}
			if (
				method === "POST" &&
				url.pathname === "/api/crm/records/company_1/restore"
			) {
				const company = recordStore.get("company_1");
				if (!company) {
					await json(404, { error: "Record not found" });
					return;
				}
				const restored = {
					...company,
					deleted_at: null,
					updated_at: TIMESTAMP,
				};
				recordStore.set("company_1", restored);
				await json(200, restored);
				return;
			}
			if (
				method === "GET" &&
				url.pathname === `/api/crm/records/${DEAL_ID}/related`
			) {
				await json(200, { groups: relatedGroups });
				return;
			}
			if (
				method === "GET" &&
				url.pathname === "/api/crm/records/company_1/related"
			) {
				await json(200, { groups: [] });
				return;
			}
			if (
				method === "GET" &&
				url.pathname === "/api/crm/records/company_2/related"
			) {
				await json(200, { groups: [] });
				return;
			}
			if (
				method === "GET" &&
				url.pathname === `/api/crm/records/${DEAL_ID}/activities`
			) {
				await json(200, {
					has_more: false,
					items: activities,
					limit: 100,
					offset: 0,
					total: activities.length,
				});
				return;
			}
			if (
				method === "GET" &&
				url.pathname.startsWith("/api/crm/records/") &&
				url.pathname.endsWith("/activities")
			) {
				await json(200, {
					has_more: false,
					items: [],
					limit: 100,
					offset: 0,
					total: 0,
				});
				return;
			}
			if (
				method === "PATCH" &&
				url.pathname === `/api/crm/records/${DEAL_ID}`
			) {
				if (!record) {
					await json(404, { error: "Record not found" });
					return;
				}
				// SAFETY: Mounted RecordDetail commitField authors a plain values object and the real CRM updateRecord serializer adds literal mode="merge"; value fields remain unknown here. This controlled route does not validate forged requests.
				const update = z
					.object({
						mode: z.literal("merge"),
						values: z.record(z.string(), z.json()),
					})
					.parse(body);
				const previous = record.values?.amount;
				const updated: CrmRecord = {
					...record,
					updated_at: TIMESTAMP,
					values: { ...record.values, ...update.values },
				};
				recordStore.set(DEAL_ID, updated);
				activities.unshift({
					...makeActivity({
						id: `audit_${requests.length}`,
						kind: "field_change",
						title: "",
					}),
					field_id: "fld_amount",
					from_value: previous,
					to_value: update.values.amount,
				});
				await json(200, updated);
				return;
			}
			if (method === "POST" && url.pathname === "/api/crm/activities") {
				// SAFETY: Mounted RecordDetail submitActivity authors this payload from native input strings (trimmed title and optional original body), its finite note/call/meeting/task kind catalog, the authored record id, and an optional ISO date string; the real CRM logActivity serializer omits undefined fields. Forged requests are outside this proof.
				const input = body as {
					body?: string;
					due_at?: string;
					kind: Activity["kind"];
					record_id?: string;
					title: string;
				};
				const created: Activity = {
					...input,
					created_at: TIMESTAMP,
					id: `activity_${requests.length}`,
					updated_at: TIMESTAMP,
				};
				activities.unshift(created);
				await json(201, created);
				return;
			}
			if (
				method === "POST" &&
				url.pathname.startsWith("/api/crm/activities/") &&
				url.pathname.endsWith("/complete")
			) {
				const id = url.pathname.split("/").at(-2);
				const activity = activities.find((candidate) => candidate.id === id);
				if (!activity) {
					await json(404, { error: "Activity not found" });
					return;
				}
				// SAFETY: Mounted RecordDetail toggleTask derives completed with native logical negation and the real CRM completeActivity serializer publishes { completed }; this controlled route excludes forged request bodies.
				const completion = body as { completed: boolean };
				activity.completed_at = completion.completed ? TIMESTAMP : null;
				await json(200, activity);
				return;
			}
			if (
				method === "DELETE" &&
				url.pathname.startsWith("/api/crm/activities/")
			) {
				const id = url.pathname.split("/").at(-1);
				const index = activities.findIndex((candidate) => candidate.id === id);
				if (index >= 0) {
					activities.splice(index, 1);
				}
				await empty();
				return;
			}
			if (
				method === "POST" &&
				url.pathname === `/api/crm/records/${DEAL_ID}/links`
			) {
				// SAFETY: Mounted RecordDetail link updates use the authored related-group field id and a one-element array of the native record id from its picker or current related records; actual CRM link/unlink serializers publish those string fields. Forged requests are outside this controlled fixture.
				const link = body as { field_id: string; target_ids: string[] };
				for (const targetId of link.target_ids) {
					const target = recordStore.get(targetId);
					if (
						target &&
						!relatedGroups[0]?.records.some(
							(candidate) => candidate.id === targetId
						)
					) {
						relatedGroups[0]?.records.push(target);
					}
				}
				await empty();
				return;
			}
			if (
				method === "POST" &&
				url.pathname === `/api/crm/records/${DEAL_ID}/unlink`
			) {
				// SAFETY: Mounted RecordDetail link updates use the authored related-group field id and a one-element array of the native record id from its picker or current related records; actual CRM link/unlink serializers publish those string fields. Forged requests are outside this controlled fixture.
				const link = body as { field_id: string; target_ids: string[] };
				if (relatedGroups[0]) {
					relatedGroups[0].records = relatedGroups[0].records.filter(
						(candidate) => !link.target_ids.includes(candidate.id)
					);
				}
				await empty();
				return;
			}

			unexpected.push(`${method} ${requestPath}: missing explicit response`);
			await json(404, {
				error: `Unexpected CRM proof request: ${method} ${requestPath}`,
			});
		}
	);

	const fixture: CrmProofFixture = {
		activities,
		failNext,
		readRecord: (id) => {
			const current = recordStore.get(id);
			return current ? structuredClone(current) : undefined;
		},
		readRelated: () => structuredClone(relatedGroups),
		requests,
		unexpected,
	};
	const state = proofStates.get(page);
	if (state) {
		state.fixture = fixture;
	}
	return fixture;
}

async function openRecord(page: Page): Promise<void> {
	await page.goto(PROOF_PAGE);
	await expect(
		page.getByRole("button", { name: "Renewal Acme" })
	).toBeVisible();
	await page.getByRole("button", { name: "Renewal Acme" }).click();
	await expect(
		page.getByRole("heading", { name: "Renewal Acme" })
	).toBeVisible();
}

async function capture(page: Page, name: string): Promise<void> {
	const target = evidencePath(name);
	await mkdir(path.dirname(target), { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: target,
	});
}

function requestFor(
	fixture: CrmProofFixture,
	method: string,
	requestPath: string
): CapturedRequest[] {
	return fixture.requests.filter(
		(request) => request.method === method && request.path === requestPath
	);
}

test.describe.configure({ timeout: 120_000 });

test("opens a record from the Harbor dock, preserves a successful write across timeline failure, and reloads exact state", async ({
	page,
}) => {
	const fixture = await installCrmApi(page);
	await openRecord(page);

	expect(requestFor(fixture, "GET", "/api/crm/records/deal_1")).toHaveLength(1);
	expect(
		requestFor(fixture, "GET", "/api/crm/records/deal_1/related")
	).toHaveLength(1);
	expect(
		requestFor(fixture, "GET", "/api/crm/records/deal_1/activities?limit=100")
	).toHaveLength(1);

	fixture.failNext("GET", "/api/crm/records/deal_1/activities?limit=100");
	await page.getByRole("button", { name: "12000", exact: true }).click();
	const amountEditor = page.getByRole("spinbutton", { name: "Amount" });
	await amountEditor.fill("42000");
	await amountEditor.press("Tab");

	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "42000", exact: true })
	).toBeVisible();
	expect(fixture.readRecord(DEAL_ID)?.values?.amount).toBe(42_000);
	expect(
		requestFor(fixture, "PATCH", "/api/crm/records/deal_1").at(-1)?.body
	).toEqual({
		mode: "merge",
		values: { amount: 42_000 },
	});
	await capture(
		page,
		"desktop-crm-record-detail-timeline-refresh-error-keeps-save"
	);

	await page.getByRole("button", { name: "← Back" }).click();
	await page.getByRole("button", { name: "Renewal Acme" }).click();
	await expect(
		page.getByRole("heading", { name: "Renewal Acme" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "42000", exact: true })
	).toBeVisible();
	await expect(
		page.getByText("Amount changed from 12000 to 42000")
	).toBeVisible();
	await capture(page, "desktop-crm-record-detail-field-persisted-after-reopen");

	await page.getByRole("button", { name: "42000", exact: true }).click();
	await page.getByRole("spinbutton", { name: "Amount" }).fill("43000");
	await page.getByRole("spinbutton", { name: "Amount" }).press("Escape");
	await expect(
		page.getByRole("button", { name: "42000", exact: true })
	).toBeVisible();
	expect(requestFor(fixture, "PATCH", "/api/crm/records/deal_1")).toHaveLength(
		1
	);

	fixture.failNext("PATCH", "/api/crm/records/deal_1");
	await page.getByRole("button", { name: "42000", exact: true }).click();
	await page.getByRole("spinbutton", { name: "Amount" }).fill("50000");
	await page.getByRole("spinbutton", { name: "Amount" }).press("Tab");
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await expect(page.getByRole("spinbutton", { name: "Amount" })).toHaveValue(
		"50000"
	);
	expect(fixture.readRecord(DEAL_ID)?.values?.amount).toBe(42_000);
	await capture(page, "desktop-crm-record-detail-field-write-error-draft");

	await page.getByRole("spinbutton", { name: "Amount" }).press("Tab");
	await expect(
		page.getByRole("button", { name: "50000", exact: true })
	).toBeVisible();
	await expect(page.getByText("Temporary CRM request failure")).toHaveCount(0);
	expect(
		requestFor(fixture, "PATCH", "/api/crm/records/deal_1").at(-1)?.body
	).toEqual({
		mode: "merge",
		values: { amount: 50_000 },
	});
	expect(fixture.readRecord(DEAL_ID)?.values?.amount).toBe(50_000);
});

test("authors each supported activity kind, retains a failed task draft, retries once, and reads the saved timeline back", async ({
	page,
}) => {
	const fixture = await installCrmApi(page);
	await openRecord(page);

	await page.getByRole("button", { name: "Task", exact: true }).click();
	await page.getByLabel("Title").fill("  Follow up  ");
	await page.getByLabel("Detail").fill("Send proposal to Acme.");
	await page.getByLabel("Due").fill("2026-10-05T13:15");
	fixture.failNext("POST", "/api/crm/activities");
	await page.getByRole("button", { name: "Add", exact: true }).click();
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await expect(page.getByLabel("Title")).toHaveValue("  Follow up  ");
	const expectedTask = {
		body: "Send proposal to Acme.",
		due_at: "2026-10-05T13:15:00.000Z",
		kind: "task",
		record_id: DEAL_ID,
		title: "Follow up",
	};
	expect(
		requestFor(fixture, "POST", "/api/crm/activities").at(-1)?.body
	).toEqual(expectedTask);

	await page.getByRole("button", { name: "Add", exact: true }).click();
	await expect(page.getByText("Follow up", { exact: true })).toBeVisible();
	await expect(
		page.getByText("Send proposal to Acme.", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("Title")).toHaveValue("");
	await expect(page.getByText("Temporary CRM request failure")).toHaveCount(0);
	await expect
		.poll(
			() =>
				fixture.activities.filter((activity) => activity.title === "Follow up")
					.length
		)
		.toBe(1);
	await expect
		.poll(
			() =>
				requestFor(
					fixture,
					"GET",
					"/api/crm/records/deal_1/activities?limit=100"
				).length
		)
		.toBe(2);

	for (const entry of [
		{ kind: "note", label: "Note", title: "Shared notes" },
		{ kind: "call", label: "Call", title: "Called buyer" },
		{ kind: "meeting", label: "Meeting", title: "Quarterly review" },
	] as const) {
		await page.getByRole("button", { name: entry.label, exact: true }).click();
		await page.getByLabel("Title").fill(entry.title);
		await page.getByRole("button", { name: "Add", exact: true }).click();
		await expect(page.getByText(entry.title, { exact: true })).toBeVisible();
	}
	expect(
		requestFor(fixture, "POST", "/api/crm/activities").map(
			(request) => request.body
		)
	).toEqual([
		expectedTask,
		expectedTask,
		{ kind: "note", record_id: DEAL_ID, title: "Shared notes" },
		{ kind: "call", record_id: DEAL_ID, title: "Called buyer" },
		{ kind: "meeting", record_id: DEAL_ID, title: "Quarterly review" },
	]);
	await capture(page, "desktop-crm-record-detail-activities-persisted");
});

test("links and unlinks cross-object records using exact ids and reopens the linked record with its own schema", async ({
	page,
}) => {
	const fixture = await installCrmApi(page);
	await openRecord(page);

	const companySearch = page.getByRole("textbox", { name: "Link a company" });
	await companySearch.fill("Globex");
	await expect(
		page.getByRole("button", { name: "Globex", exact: true })
	).toBeVisible();
	expect(
		requestFor(fixture, "POST", "/api/crm/objects/company/records/query").at(-1)
			?.body
	).toEqual({ limit: 6, search: "Globex" });
	await page.getByRole("button", { name: "Globex", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Unlink Globex" })
	).toBeVisible();
	expect(
		requestFor(fixture, "POST", "/api/crm/records/deal_1/links").at(-1)?.body
	).toEqual({
		field_id: "fld_company",
		target_ids: ["company_2"],
	});
	expect(fixture.readRelated()[0]?.records.map((entry) => entry.id)).toContain(
		"company_2"
	);

	fixture.failNext("POST", "/api/crm/records/deal_1/unlink");
	await page.getByRole("button", { name: "Unlink Globex" }).click();
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Unlink Globex" })
	).toBeVisible();
	await page.getByRole("button", { name: "Unlink Globex" }).click();
	await expect(page.getByRole("button", { name: "Unlink Globex" })).toHaveCount(
		0
	);
	await expect(page.getByRole("button", { name: "Unlink Acme" })).toBeVisible();
	await expect(page.getByText("Temporary CRM request failure")).toHaveCount(0);
	expect(
		requestFor(fixture, "POST", "/api/crm/records/deal_1/unlink").at(-1)?.body
	).toEqual({
		field_id: "fld_company",
		target_ids: ["company_2"],
	});

	await page.getByRole("button", { name: "Acme", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible();
	await expect(page.getByText("Company", { exact: true })).toBeVisible();
	await expect(
		page.getByText("https://acme.example", { exact: true })
	).toBeVisible();
	expect(requestFor(fixture, "GET", "/api/crm/records/company_1")).toHaveLength(
		1
	);
	await capture(page, "desktop-crm-record-detail-related-company-open");
});

test("task completion and activity deletion roll back on failure, retry, and survive reopen", async ({
	page,
}) => {
	const fixture = await installCrmApi(page);
	await openRecord(page);

	fixture.failNext("POST", "/api/crm/activities/task_proposal/complete");
	await page.getByRole("checkbox", { name: "Mark this task complete" }).click();
	await expect(
		page.getByRole("checkbox", { name: "Mark this task complete" })
	).toBeVisible();
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	expect(
		requestFor(
			fixture,
			"POST",
			"/api/crm/activities/task_proposal/complete"
		).at(-1)?.body
	).toEqual({ completed: true });

	await page.getByRole("checkbox", { name: "Mark this task complete" }).click();
	await expect(
		page.getByRole("checkbox", { name: "Reopen this task" })
	).toBeVisible();
	await expect(page.getByText("Temporary CRM request failure")).toHaveCount(0);
	expect(
		fixture.activities.find((activity) => activity.id === "task_proposal")
			?.completed_at
	).toBe(TIMESTAMP);

	fixture.failNext("DELETE", "/api/crm/activities/note_kickoff");
	const kickoff = page
		.getByRole("listitem")
		.filter({ hasText: "Kickoff notes" });
	await kickoff.getByRole("button", { name: "Delete this entry" }).click();
	await expect(kickoff).toBeVisible();
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await kickoff.getByRole("button", { name: "Delete this entry" }).click();
	await expect(page.getByText("Kickoff notes", { exact: true })).toHaveCount(0);
	await expect(page.getByText("Temporary CRM request failure")).toHaveCount(0);
	expect(
		fixture.activities.some((activity) => activity.id === "note_kickoff")
	).toBe(false);

	await page.getByRole("button", { name: "← Back" }).click();
	await page.getByRole("button", { name: "Renewal Acme" }).click();
	await expect(
		page.getByRole("checkbox", { name: "Reopen this task" })
	).toBeVisible();
	await expect(page.getByText("Kickoff notes", { exact: true })).toHaveCount(0);
	await expect(
		page.getByText("Amount changed from 10000 to 12000")
	).toBeVisible();
	await capture(page, "desktop-crm-record-detail-task-delete-readback");
});

test("backs out of a record whose read fails instead of leaving the dock panel stuck", async ({
	page,
}) => {
	const fixture = await installCrmApi(page);
	fixture.failNext("GET", "/api/crm/records/deal_1", 404);
	await page.goto(PROOF_PAGE);
	await page.getByRole("button", { name: "Renewal Acme" }).click();
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await page.getByRole("button", { name: "Back", exact: true }).click();
	await expect(
		page.getByRole("button", { name: "Renewal Acme" })
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Renewal Acme" })).toHaveCount(
		0
	);
	expect(requestFor(fixture, "GET", "/api/crm/records/deal_1")).toHaveLength(1);
});

test("restores a soft-deleted related record, clears failure on retry, and verifies server readback", async ({
	page,
}) => {
	const fixture = await installCrmApi(page, { linkedCompanyDeleted: true });
	await openRecord(page);

	await page.getByRole("button", { name: "Acme", exact: true }).click();
	await expect(page.getByRole("heading", { name: "Acme" })).toBeVisible();
	await expect(
		page.getByText("Company · deleted", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Restore", exact: true })
	).toBeVisible();

	fixture.failNext("POST", "/api/crm/records/company_1/restore");
	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(page.getByText("Temporary CRM request failure")).toBeVisible();
	await expect(
		page.getByText("Company · deleted", { exact: true })
	).toBeVisible();
	expect(fixture.readRecord("company_1")?.deleted_at).toBe(TIMESTAMP);

	await page.getByRole("button", { name: "Restore", exact: true }).click();
	await expect(
		page.getByText("Company · deleted", { exact: true })
	).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "Restore", exact: true })
	).toHaveCount(0);
	await expect(page.getByText("Temporary CRM request failure")).toHaveCount(0);
	expect(fixture.readRecord("company_1")?.deleted_at).toBeNull();
	expect(
		requestFor(fixture, "POST", "/api/crm/records/company_1/restore")
	).toHaveLength(2);
	expect(
		requestFor(fixture, "GET", "/api/crm/records/company_1").at(-1)?.status
	).toBe(200);
	await capture(page, "desktop-crm-record-detail-related-record-restored");
});
