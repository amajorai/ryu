import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";
import {
	calls,
	capture,
	clearTargetRequests,
	createProjectThroughWizard,
	fixture,
	mountChecks,
	requests,
	selectVisibleTab,
	targetRequests,
} from "./checks-companion-proof.helpers.ts";
import type {} from "./harness/checks-companion-proof.tsx";

test("API case edits produce live evidence, failure bundles, and a persistent healed decision", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountChecks(page);
	const target = await fixture(page);
	const project = await createProjectThroughWizard(page, companion, {
		name: "Checks API Fixture",
		projectType: "API",
		projectUrl: target.projectUrl,
		runtime: "agent",
		generatePlan: false,
		brief: "Verify a local API health contract and retain failure evidence.",
	});
	expect(project.testIds).toHaveLength(3);
	await companion.getByRole("tab", { name: "Endpoint Tests" }).click();
	await expect(
		companion.getByRole("button", { name: "Add test from plan" })
	).toHaveCount(0);
	const testId = project.testIds[0];
	await companion
		.getByRole("option", {
			name: /Returning user signs in and reaches the dashboard/,
		})
		.click();
	await expect(
		companion.getByRole("heading", {
			name: "Returning user signs in and reaches the dashboard",
		})
	).toBeVisible();
	await companion.getByRole("button", { name: "Refine plan" }).click();
	await companion
		.getByLabel("Description")
		.fill("Unsaved changes should be canceled.");
	await companion.getByRole("button", { name: "Cancel" }).click();
	await expect(
		companion.getByText(
			"Verify the Authentication journey against the live target."
		)
	).toBeVisible();
	expect(requests(await calls(page), "PATCH", `/tests/${testId}`)).toHaveLength(
		0
	);

	await companion.getByRole("button", { name: "Edit plan" }).click();
	await companion
		.getByLabel("Description")
		.fill("Check local API health response.");
	await companion.getByLabel("HTTP method").fill("GET");
	await companion.getByLabel("Max response time · optional ms").fill("3000");
	await companion.getByLabel("Request path").fill("/api/health");
	await companion.getByLabel("Expected status").fill("200");
	await companion
		.getByLabel("Response assertions · one per line")
		.fill("contains:ok");
	await companion
		.getByLabel("Steps · one per line")
		.fill("Request local health\nConfirm the JSON status signal");
	await companion.getByRole("button", { name: "Save plan" }).click();
	await expect(
		companion.getByText("Test plan saved. Run it to attach fresh evidence.")
	).toBeVisible();
	const healthUpdate = requests(
		await calls(page),
		"PATCH",
		`/tests/${testId}`
	)[0];
	expect(healthUpdate?.status).toBe(200);
	expect(healthUpdate?.body).toEqual({
		description: "Check local API health response.",
		expectedStatus: 200,
		maxResponseTimeMs: 3000,
		requestMethod: "GET",
		requestPath: "/api/health",
		responseAssertions: ["contains:ok"],
		steps: ["Request local health", "Confirm the JSON status signal"],
	});
	await companion.getByRole("button", { name: "Checks API Fixture" }).click();
	await expect(companion.locator(".topbar-context strong")).toHaveText(
		"Checks API Fixture"
	);
	await companion
		.getByRole("option", {
			name: /Returning user signs in and reaches the dashboard/,
		})
		.click();
	await expect(
		companion.getByText("Check local API health response.", { exact: true })
	).toBeVisible();

	await clearTargetRequests(page);
	await companion.getByRole("button", { name: "Run case" }).click();
	await expect(companion.locator(".terminal-output")).toContainText(
		"200 Untitled response"
	);
	const healthRun = requests(
		await calls(page),
		"POST",
		`/tests/${testId}/run`
	).at(-1);
	expect(healthRun?.status).toBe(200);
	expect(healthRun?.result).toMatchObject({
		failed: 0,
		scope: "test",
		targetTestId: testId,
	});
	expect(await targetRequests(page)).toEqual([
		{ method: "GET", path: "/api/health" },
	]);

	await companion.getByRole("button", { name: "Refine plan" }).click();
	await companion.getByLabel("Request path").fill("/api/fail");
	await companion.getByRole("button", { name: "Save plan" }).click();
	await expect(
		companion.getByText("Test plan saved. Run it to attach fresh evidence.")
	).toBeVisible();
	await selectVisibleTab(companion, /Code/);
	await expect(companion.locator(".code-stage")).toContainText(
		'requests.get("/api/fail")'
	);
	await selectVisibleTab(companion, /Preview/);
	await expect(companion.locator(".preview-url")).toHaveText(
		`${target.projectUrl}/api/fail`
	);
	await companion.getByRole("tab", { name: "Chat" }).click();
	await expect(
		companion.getByText(
			"Agent-assisted refinement isn't available here yet. Use Edit plan to update this case."
		)
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Suggest refinement" })
	).toHaveCount(0);
	await expect(
		companion.getByPlaceholder("Describe a refinement…")
	).toHaveCount(0);
	await companion.getByRole("tab", { name: "Overview" }).click();
	await companion.getByRole("button", { name: "Run case" }).click();
	await expect(companion.locator(".terminal-output")).toContainText(
		"503 Untitled response"
	);
	const failedCaseRun = requests(
		await calls(page),
		"POST",
		`/tests/${testId}/run`
	).at(-1);
	const failedRun = z
		.object({
			failed: z.number(),
			failures: z.array(z.object({ id: z.string(), rootCause: z.string() })),
		})
		.parse(failedCaseRun?.result);
	expect(failedRun?.failed).toBe(1);
	expect(failedRun?.failures[0]?.rootCause).toBe("http_expected_200");

	await companion.getByRole("button", { name: "Run project" }).click();
	await expect(
		companion.getByText("Checks API Fixture finished with 1 failure bundle.")
	).toBeVisible();
	const projectRun = requests(
		await calls(page),
		"POST",
		`/projects/${project.projectId}/runs`
	).at(-1);
	// SAFETY: This captured project-run result is the concrete native retained run report (failed count and failure id/rootCause fields); the exact same call's successful status is checked immediately below. This is a native producer projection, not arbitrary JSON validation.
	const report = projectRun?.result as
		| { failed: number; failures: Array<{ id: string; rootCause: string }> }
		| undefined;
	expect(projectRun?.status).toBe(200);
	expect(report?.failed).toBe(1);
	expect(report?.failures[0]?.rootCause).toBe("http_expected_200");
	// SAFETY: The successful retained native report checked above owns its string run id from the actual runner/store serializer; the optional view only handles an absent captured call.
	const failedRunId = (projectRun?.result as { id?: string } | undefined)?.id;
	const failureId = report?.failures[0]?.id;
	if (!(failedRunId && failureId)) {
		throw new Error(
			"The Checks sidecar did not return its retained failure bundle."
		);
	}
	await companion.getByRole("button", { name: "Checks API Fixture" }).click();
	await selectVisibleTab(companion, /Test Report/);
	await expect(companion.getByText("http_expected_200")).toBeVisible();
	await companion.getByRole("button", { name: "Heal plan" }).click();
	await expect(companion.getByText("Plan healed")).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Healed" })
	).toBeDisabled();
	const healCall = requests(
		await calls(page),
		"POST",
		`/runs/${failedRunId}/failures/${failureId}/heal`
	)[0];
	expect(healCall?.status).toBe(200);
	expect(healCall?.body).toBeUndefined();
	await capture(companion, "checks-companion-api-failure-healed.png");

	await mountChecks(page, { screen: "all-tests-api", tenantUserId });
	const persisted = page.frameLocator("iframe");
	await expect(
		persisted.getByRole("heading", { name: "All Tests" })
	).toBeVisible();
	await persisted.getByRole("button", { name: "Open project" }).click();
	await selectVisibleTab(persisted, /Test Report/);
	await expect(persisted.getByText("Plan healed")).toBeVisible();
});

test("test lists save case membership and monitoring schedules run and persist their state", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountChecks(page);
	const target = await fixture(page);
	const project = await createProjectThroughWizard(page, companion, {
		name: "Checks Collection Fixture",
		projectType: "API",
		projectUrl: target.projectUrl,
		runtime: "agent",
		generatePlan: false,
		brief: "A small local regression collection for schedule proof.",
	});
	await companion.getByRole("button", { name: "Open test lists" }).click();
	await expect(
		companion.getByRole("heading", { name: "Test Lists" })
	).toBeVisible();
	await companion.getByRole("button", { name: "New list" }).click();
	await companion
		.getByRole("textbox", { name: "Test list name" })
		.fill("Checks release gate");
	await companion.getByRole("button", { name: "Create list" }).click();
	await expect(
		companion.getByText("Checks release gate", { exact: true })
	).toBeVisible();
	await companion.getByRole("button", { name: "Edit cases" }).click();
	await companion
		.getByRole("checkbox", {
			name: "New user signs up and reaches the dashboard",
		})
		.uncheck();
	await companion
		.getByRole("checkbox", { name: "Search returns an app detail page" })
		.uncheck();
	await companion.getByRole("button", { name: "Save cases" }).click();
	const listWrite = requests(await calls(page), "POST", "/lists").at(-1);
	const listRecord = z
		.object({ id: z.string(), name: z.string() })
		.parse(listWrite?.result);
	if (!listRecord?.id) {
		throw new Error("The Checks sidecar did not return the created test list.");
	}
	expect(listWrite?.body).toEqual({ name: "Checks release gate" });
	await expect(companion.getByText("0 UI · 1 API")).toBeVisible();
	await expect
		.poll(
			async () =>
				requests(await calls(page), "PATCH", `/lists/${listRecord.id}`)[0]
					?.status
		)
		.toBe(200);
	const membershipWrite = requests(
		await calls(page),
		"PATCH",
		`/lists/${listRecord.id}`
	)[0];
	expect(membershipWrite?.body).toEqual({ testIds: [project.testIds[0]] });
	await clearTargetRequests(page);
	await companion.getByRole("button", { name: "Run now" }).click();
	await expect(
		companion.getByText(/Checks release gate finished with 0 attention runs/)
	).toBeVisible();
	const listRun = requests(
		await calls(page),
		"POST",
		`/lists/${listRecord.id}/runs`
	)[0];
	expect(listRun?.status).toBe(200);
	expect(
		capturedJsonArray(capturedJsonField(listRun?.result, "runs"))
	).toMatchObject([{ failed: 0, passed: 1, trigger: "list" }]);
	expect(await targetRequests(page)).toEqual([
		{ method: "GET", path: "/" },
		{ method: "GET", path: "/" },
	]);
	await capture(companion, "checks-companion-test-list-membership-run.png");

	await mountChecks(page, { screen: "monitoring", tenantUserId });
	const monitoring = page.frameLocator("iframe");
	await expect(
		monitoring.getByRole("heading", { name: "Monitoring" })
	).toBeVisible();
	await monitoring.getByRole("button", { name: "New schedule" }).click();
	await monitoring
		.getByRole("textbox", { name: "Schedule name" })
		.fill("Checks twice daily");
	await monitoring
		.getByRole("textbox", { name: "Schedule frequency" })
		.fill("Every 12 hours");
	await monitoring.getByRole("button", { name: "Create schedule" }).click();
	await expect(monitoring.getByText("Checks twice daily")).toBeVisible();
	const scheduleWrite = requests(await calls(page), "POST", "/schedules").at(
		-1
	);
	const schedule = z
		.object({ active: z.boolean(), id: z.string(), lastResult: z.string() })
		.parse(scheduleWrite?.result);
	if (!schedule?.id) {
		throw new Error("The Checks sidecar did not return the scheduled task.");
	}
	expect(scheduleWrite?.body).toEqual({
		frequency: "Every 12 hours",
		listId: listRecord.id,
		name: "Checks twice daily",
	});
	expect(schedule.active).toBe(true);
	const scheduleToggle = monitoring.getByRole("switch", {
		name: "Activate Checks twice daily",
	});
	await expect(scheduleToggle).toBeChecked();
	await scheduleToggle.click();
	await expect(scheduleToggle).not.toBeChecked();
	await scheduleToggle.click();
	await expect(scheduleToggle).toBeChecked();
	const scheduleUpdates = requests(
		await calls(page),
		"PATCH",
		`/schedules/${schedule.id}`
	);
	expect(scheduleUpdates.map((call) => call.body?.active)).toEqual([
		false,
		true,
	]);
	await clearTargetRequests(page);
	await monitoring.getByRole("button", { name: "Run now" }).click();
	await expect(
		monitoring.getByText(/Checks twice daily finished with 0 attention runs/)
	).toBeVisible();
	const scheduleRun = requests(
		await calls(page),
		"POST",
		`/schedules/${schedule.id}/run`
	)[0];
	expect(scheduleRun?.status).toBe(200);
	expect(scheduleRun?.result).toMatchObject({
		runs: [{ failed: 0, passed: 1 }],
		schedule: { lastResult: "passed" },
	});
	await scheduleToggle.click();
	await expect(scheduleToggle).not.toBeChecked();
	await mountChecks(page, { screen: "monitoring", tenantUserId });
	const persistedMonitoring = page.frameLocator("iframe");
	await expect(
		persistedMonitoring.getByRole("switch", {
			name: "Activate Checks twice daily",
		})
	).not.toBeChecked();
	await expect(
		persistedMonitoring.getByText("Checks twice daily")
	).toBeVisible();
	await capture(persistedMonitoring, "checks-companion-schedule-persisted.png");
});

test("Checks settings routes expose the node and CI boundaries without external writes", async ({
	page,
}) => {
	const { companion } = await mountChecks(page, {
		screen: "settings-api-keys",
	});
	await expect(
		companion.getByText(
			"No third-party credential is required for the built-in live-http lane."
		)
	).toBeVisible();
	await expect(
		companion.getByText(
			"No third-party credential is required for the built-in live-http lane."
		)
	).toBeVisible();
	const settingsNavigation = companion.getByRole("listbox", {
		name: "Settings sections",
	});
	const githubSettings = settingsNavigation.getByRole("option", {
		name: /GitHub App/,
	});
	await githubSettings.click();
	await expect(githubSettings).toHaveAttribute("aria-selected", "true");
	await expect(
		companion.getByText("GitHub merge gates remain an external CI integration.")
	).toBeVisible();
	const viewCiSetup = companion.getByRole("button", { name: "View CI setup" });
	await expect(viewCiSetup).toBeEnabled();
	await viewCiSetup.click();
	await expect
		.poll(async () =>
			(await page.evaluate(() => window.__checksProof.hostCalls())).filter(
				(call) => call.method === "ui.openExternal"
			)
		)
		.toEqual([
			{
				input: {
					href: "https://docs.ryuhq.com/docs/apps/checks#cli-ci-and-mcp",
				},
				method: "ui.openExternal",
			},
		]);
	await expect(companion.getByText("External integration")).toBeVisible();
	await capture(companion, "checks-companion-settings-ci-guide-action.png");
	const capabilitiesSettings = settingsNavigation.getByRole("option", {
		name: /Capabilities/,
	});
	await capabilitiesSettings.click();
	await expect(capabilitiesSettings).toHaveAttribute("aria-selected", "true");
	await expect(
		companion.getByText("Checks capability matrix", { exact: true })
	).toBeVisible();
	await expect(companion.getByText(/live-http/)).toBeVisible();
	const apiKeySettings = settingsNavigation.getByRole("option", {
		name: /API Keys/,
	});
	await apiKeySettings.click();
	await expect(apiKeySettings).toHaveAttribute("aria-selected", "true");
	await expect(
		companion.getByText(
			"No third-party credential is required for the built-in live-http lane."
		)
	).toBeVisible();
	expect(
		(await calls(page)).some(
			(call) => call.method === "POST" || call.method === "PATCH"
		)
	).toBe(false);
	await capture(companion, "checks-companion-settings-api-keys.png");
});
