// Continues checks-companion-proof.spec.ts (split under the file token limit); helpers live in checks-companion-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import { z } from "zod";
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

test("project exploration and runs persist live HTTP and separate agent evidence", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountChecks(page);
	const target = await fixture(page);
	const project = await createProjectThroughWizard(page, companion, {
		name: "Checks Agent Fixture",
		projectType: "Mixed",
		projectUrl: target.projectUrl,
		runtime: "agent",
		generatePlan: false,
		brief: "A local fixture supports sign-in, search, and checkout workflows.",
	});
	expect(project.testIds).toHaveLength(3);
	await clearTargetRequests(page);
	await companion.getByRole("tab", { name: "Site Exploration" }).click();
	await expect(companion.getByText("No exploration yet")).toBeVisible();
	await companion.getByRole("button", { name: "Explore target" }).click();
	await expect(companion.getByText(/live-http · completed/i)).toBeVisible();
	const explorationCall = (await calls(page)).find(
		(call) => call.method === "POST" && call.path.endsWith("/explore")
	);
	expect(explorationCall?.status).toBe(200);
	// SAFETY: The same captured call is confirmed successful above. This exact built Checks companion receives the real native exploration serializer, whose canonical model authors numeric coverage and observed booleans in featureAreas. The harness records the unchanged native result/status together.
	expect(
		(
			explorationCall?.result as {
				coverage?: number;
				featureAreas?: Array<{ observed: boolean }>;
			}
		)?.featureAreas?.every((area) => area.observed)
	).toBe(true);
	expect(await targetRequests(page)).toEqual([{ method: "GET", path: "/" }]);
	await companion.getByRole("button", { name: "Explore again" }).click();
	await expect(companion.getByText(/live-http · completed/i)).toBeVisible();
	expect(
		requests(
			await calls(page),
			"POST",
			`/projects/${project.projectId}/explore`
		)
	).toHaveLength(2);
	expect(await targetRequests(page)).toHaveLength(2);

	await companion.getByRole("tab", { name: "Use Case Flow" }).click();
	const firstCase = companion.getByRole("option", {
		name: /Returning user signs in and reaches the dashboard/,
	});
	await firstCase.click();
	await expect(
		companion.getByRole("heading", {
			name: "Returning user signs in and reaches the dashboard",
		})
	).toBeVisible();
	await selectVisibleTab(companion, /Code/);
	await expect(companion.locator(".code-stage")).toContainText(
		`page.goto("${target.projectUrl}")`
	);
	await selectVisibleTab(companion, /Preview/);
	await expect(companion.locator(".preview-url")).toHaveText(target.projectUrl);
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
	await companion.getByRole("button", { name: "Refine plan" }).click();
	await companion
		.getByLabel("Description")
		.fill("Unsaved description that must be discarded.");
	await companion.getByRole("button", { name: "Cancel" }).click();
	await expect(
		companion.getByText(
			"Verify the Authentication journey against the live target."
		)
	).toBeVisible();
	expect(
		(await calls(page)).some(
			(call) => call.method === "PATCH" && call.path.startsWith("/tests/")
		)
	).toBe(false);
	await companion.getByRole("button", { name: "Edit plan" }).click();
	await companion
		.getByLabel("Description")
		.fill("Saved local fixture sign-in journey.");
	await companion
		.getByLabel("Steps · one per line")
		.fill("Open local sign-in\nVerify dashboard signal");
	await companion.getByRole("button", { name: "Save plan" }).click();
	await expect(
		companion.getByText("Test plan saved. Run it to attach fresh evidence.")
	).toBeVisible();
	const testId = project.testIds[0];
	const planWrite = requests(await calls(page), "PATCH", `/tests/${testId}`)[0];
	expect(planWrite?.body).toMatchObject({
		description: "Saved local fixture sign-in journey.",
		steps: ["Open local sign-in", "Verify dashboard signal"],
	});
	expect(planWrite?.status).toBe(200);
	await clearTargetRequests(page);
	await companion.getByRole("button", { name: "Run case" }).click();
	await expect(companion.locator(".terminal-output")).toContainText(
		"200 Checks Local Fixture"
	);
	const caseRun = requests(
		await calls(page),
		"POST",
		`/tests/${testId}/run`
	)[0];
	expect(caseRun?.status).toBe(200);
	// The sign-in case is a UI case; without browser.control it passes over
	// HTTP and keeps the browser-fallback label instead of claiming browser proof.
	expect(caseRun?.result).toMatchObject({
		evidenceLevel: "live-http-fallback",
		passed: 1,
		scope: "test",
	});
	const caseTargetCalls = await targetRequests(page);
	expect(caseTargetCalls).toEqual([{ method: "GET", path: "/" }]);
	await expect(
		companion.getByText("The case passed with live evidence.")
	).toBeVisible();
	await clearTargetRequests(page);
	await companion.getByRole("button", { name: "Run project" }).click();
	await expect(
		companion.getByText("Checks Agent Fixture passed with live evidence.")
	).toBeVisible();
	const projectRun = requests(
		await calls(page),
		"POST",
		`/projects/${project.projectId}/runs`
	).at(-1);
	expect(projectRun?.status).toBe(200);
	const projectRunResult = z
		.object({
			evidence: z.array(z.json()).optional(),
			evidenceLevel: z.string().optional(),
			passed: z.number().optional(),
			failed: z.number().optional(),
		})
		.parse(projectRun?.result);
	expect(projectRunResult).toMatchObject({
		evidenceLevel: "live-http-fallback",
		passed: 3,
		failed: 0,
	});
	expect(projectRunResult?.evidence).toHaveLength(3);
	const projectTargetCalls = await targetRequests(page);
	expect(projectTargetCalls).toHaveLength(4);
	expect(
		projectTargetCalls.every(
			(call) => call.method === "GET" && call.path === "/"
		)
	).toBe(true);
	const agentCall = (
		await page.evaluate(() => window.__checksProof.hostCalls())
	).find((call) => call.method === "agent.run");
	expect(agentCall?.input).toMatchObject({ agent_id: "checks-fixture-agent" });
	expect(
		requests(
			await calls(page),
			"POST",
			`/projects/${project.projectId}/agent-runs`
		)[0]?.status
	).toBe(200);
	await companion.getByRole("button", { name: "Checks Agent Fixture" }).click();
	await expect(
		companion.getByRole("heading", { name: "Checks Agent Fixture" })
	).toBeVisible();
	await companion.getByRole("tab", { name: "Agent Actions" }).click();
	await expect(
		companion.getByText(/"evidenceLevel":"agent-transcript"/)
	).toBeVisible();
	await expect(
		companion.getByText("Not captured · Browser screenshot")
	).toBeVisible();
	await companion.getByRole("tab", { name: "Test Report" }).click();
	await expect(companion.getByText("No failure bundles")).toBeVisible();
	await companion.getByRole("tab", { name: "Run History" }).click();
	await expect(
		companion.getByText("2 runs kept for Checks Agent Fixture")
	).toBeVisible();
	const runHistoryHeaders = await companion
		.locator(".run-history-table .test-table-head > span")
		.evaluateAll((headers) =>
			headers.map((header) => {
				const bounds = header.getBoundingClientRect();
				return {
					label: header.textContent?.trim() ?? "",
					left: bounds.left,
					right: bounds.right,
				};
			})
		);
	expect(runHistoryHeaders.map((header) => header.label)).toEqual([
		"Verdict",
		"Trigger",
		"Coverage",
		"Evidence",
		"Finished at",
	]);
	expect(
		runHistoryHeaders.every(
			(header, index) =>
				index === 0 || header.left >= (runHistoryHeaders[index - 1]?.right ?? 0)
		)
	).toBe(true);
	await capture(companion, "checks-companion-agent-live-http-report.png");

	await mountChecks(page, { screen: "home", tenantUserId });
	const home = page.frameLocator("iframe");
	await expect(home.getByRole("button", { name: "See all" })).toBeVisible();
	await home.getByRole("button", { name: "See all" }).click();
	await expect(home.getByRole("heading", { name: "All Tests" })).toBeVisible();
	await mountChecks(page, { screen: "home", tenantUserId });
	const reloadedHome = page.frameLocator("iframe");
	const recentRuns = reloadedHome.getByRole("option", {
		name: /Checks Agent Fixture/,
	});
	await expect(recentRuns).toHaveCount(2);
	const recentRun = recentRuns.first();
	await expect(recentRun).toBeVisible();
	await recentRun.click();
	await expect(reloadedHome.locator(".topbar-context strong")).toBeVisible();
	await expect(reloadedHome.locator(".topbar-context strong")).toHaveText(
		"Checks Agent Fixture"
	);
	await reloadedHome.getByRole("button", { name: "All Tests" }).click();
	await expect(
		reloadedHome.getByRole("heading", { name: "All Tests" })
	).toBeVisible();
	const apiProject = await createProjectThroughWizard(page, reloadedHome, {
		name: "Checks API Fixture",
		projectType: "API",
		projectUrl: target.projectUrl,
		runtime: "agent",
		generatePlan: false,
		brief: "Verify HTTP contracts against the local test endpoint.",
	});
	await reloadedHome.getByRole("button", { name: "All Tests" }).click();
	await reloadedHome.getByRole("tab", { name: "UI tests" }).click();
	await expect(
		reloadedHome.getByText("Checks Agent Fixture", { exact: true })
	).toBeVisible();
	await expect(
		reloadedHome.getByText("Checks API Fixture", { exact: true })
	).toHaveCount(0);
	await selectVisibleTab(reloadedHome, /API tests/);
	await expect(
		reloadedHome.getByText("Checks Agent Fixture", { exact: true })
	).toBeVisible();
	await expect(
		reloadedHome.getByText("Checks API Fixture", { exact: true })
	).toBeVisible();
	const projectSearch = reloadedHome.getByRole("textbox", {
		name: "Search projects",
	});
	await projectSearch.fill("not a project");
	await expect(reloadedHome.getByText("No projects found")).toBeVisible();
	await projectSearch.fill("Checks API Fixture");
	await clearTargetRequests(page);
	await reloadedHome
		.getByRole("button", { name: "Run Checks API Fixture" })
		.click();
	await expect(
		reloadedHome.getByText("Checks API Fixture passed with live evidence.")
	).toBeVisible();
	await expect
		.poll(
			async () =>
				requests(
					await calls(page),
					"POST",
					`/projects/${apiProject.projectId}/runs`
				).at(-1)?.status
		)
		.toBe(200);
	const cardRun = requests(
		await calls(page),
		"POST",
		`/projects/${apiProject.projectId}/runs`
	).at(-1);
	expect(cardRun?.status).toBe(200);
	expect(cardRun?.body).toEqual({ trigger: "manual" });
	expect(cardRun?.result).toMatchObject({
		evidenceLevel: "live-http",
		failed: 0,
		passed: 3,
	});
	expect(await targetRequests(page)).toHaveLength(4);
	await reloadedHome.getByRole("button", { name: "Open project" }).click();
	await selectVisibleTab(reloadedHome, /Test Report/);
	await expect(reloadedHome.getByText("No failure bundles")).toBeVisible();
	await capture(reloadedHome, "checks-companion-api-all-tests-run.png");
});
