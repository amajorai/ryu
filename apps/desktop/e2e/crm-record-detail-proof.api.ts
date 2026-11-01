import type { Page } from "@playwright/test";
import { z } from "zod";
import type { Activity, CrmRecord, RelatedGroup } from "@/src/lib/api/crm.ts";
import {
	type CapturedRequest,
	type CrmFixtureOptions,
	type CrmProofFixture,
	DEAL_ID,
	makeActivity,
	makeFixtureSchema,
	proofStates,
	TIMESTAMP,
} from "./crm-record-detail-proof.fixture.ts";

export async function installCrmApi(
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
				// `delete_activity` answers `{ ok: true }` (apps-store/crm/backend/src/api/timeline.rs).
				await json(200, { ok: true });
				return;
			}
			if (
				method === "POST" &&
				url.pathname === `/api/crm/records/${DEAL_ID}/links`
			) {
				// SAFETY: Mounted RecordDetail link updates use the authored related-group field id and a one-element array of the native record id from its picker or current related records; actual CRM link/unlink serializers publish those string fields. Forged requests are outside this controlled fixture.
				const link = body as { field_id: string; target_record_ids: string[] };
				for (const targetId of link.target_record_ids) {
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
				// Link and unlink answer the backend's `RecordUpdate { record, changed }`.
				await json(200, { changed: [], record });
				return;
			}
			if (
				method === "POST" &&
				url.pathname === `/api/crm/records/${DEAL_ID}/unlink`
			) {
				// SAFETY: Mounted RecordDetail link updates use the authored related-group field id and a one-element array of the native record id from its picker or current related records; actual CRM link/unlink serializers publish those string fields. Forged requests are outside this controlled fixture.
				const link = body as { field_id: string; target_record_ids: string[] };
				if (relatedGroups[0]) {
					relatedGroups[0].records = relatedGroups[0].records.filter(
						(candidate) => !link.target_record_ids.includes(candidate.id)
					);
				}
				// Link and unlink answer the backend's `RecordUpdate { record, changed }`.
				await json(200, { changed: [], record });
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
