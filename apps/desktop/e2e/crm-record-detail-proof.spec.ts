import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { installCrmApi } from "./crm-record-detail-proof.api.ts";
import {
	capture,
	DEAL_ID,
	evidenceDir,
	openRecord,
	PROOF_PAGE,
	proofStates,
	requestFor,
	TIMESTAMP,
} from "./crm-record-detail-proof.fixture.ts";

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

	await page.getByRole("button", { name: "Back", exact: true }).click();
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
		target_record_ids: ["company_2"],
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
		target_record_ids: ["company_2"],
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

	await page.getByRole("button", { name: "Back", exact: true }).click();
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
