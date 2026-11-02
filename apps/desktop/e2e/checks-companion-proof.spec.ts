import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
	APP_HTML,
	calls,
	capture,
	clearTargetRequests,
	contrastRatio,
	createProjectThroughWizard,
	fixture,
	mountChecks,
	requests,
	selectVisibleTab,
	targetRequests,
} from "./checks-companion-proof.helpers.ts";
import type {} from "./harness/checks-companion-proof.tsx";

test("the production Checks app mounts and recovers from workspace refresh errors", async ({
	page,
}) => {
	await page.goto("/checks-companion-proof.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(() => {
		window.__checksProof.failNext({
			message: "Fixture bootstrap is temporarily unavailable.",
			method: "GET",
			path: "/bootstrap",
			status: 503,
		});
	});
	const tenantUserId = `checks-proof-${randomUUID()}`;
	await page.evaluate(
		({ appHtml, userId }) =>
			window.__checksProof.mount({
				appHtml,
				orgId: "checks-proof-org",
				screen: "home",
				tenantUserId: userId,
			}),
		{ appHtml: readFileSync(APP_HTML, "utf8"), userId: tenantUserId }
	);
	await expect
		.poll(() => page.evaluate(() => window.__checksProof.connected()))
		.toBe(true);
	const companion = page.frameLocator("iframe");
	await expect(companion.getByRole("heading", { name: "Home" })).toBeVisible();
	await expect(
		companion.getByText("Fixture bootstrap is temporarily unavailable.")
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Refresh verification workspace" })
		.click();
	await expect(companion.getByText("No runs yet")).toBeVisible();
	const bootstrapCalls = requests(await calls(page), "GET", "/bootstrap");
	expect(bootstrapCalls.map((call) => call.status)).toEqual([503, 200]);
	expect(bootstrapCalls[1]?.tenantUserId).toBe(tenantUserId);
	await capture(companion, "checks-companion-home-empty-recovered.png");
});

test("Checks Help feedback has readable contrast", async ({ page }) => {
	const { companion } = await mountChecks(page);
	await companion.getByRole("button", { name: "Help" }).click();
	const message = companion.getByText(
		"Checks stores live evidence in the node-local sidecar."
	);
	await expect(message).toBeVisible();
	await capture(companion, "checks-companion-help-toast-contrast.png");
	const colors = await message.evaluate((element) => {
		const toast = element.closest(".toast");
		if (!toast) {
			throw new Error("The Help message must stay inside its live toast.");
		}
		const context = document
			.createElement("canvas")
			.getContext("2d", { willReadFrequently: true });
		if (!context) {
			throw new Error("Canvas color conversion is unavailable.");
		}
		const toSrgb = (color: string): number[] => {
			context.clearRect(0, 0, 1, 1);
			context.fillStyle = color;
			context.fillRect(0, 0, 1, 1);
			return Array.from(context.getImageData(0, 0, 1, 1).data.slice(0, 3));
		};
		return {
			background: toSrgb(getComputedStyle(toast).backgroundColor),
			foreground: toSrgb(getComputedStyle(element).color),
		};
	});
	expect(contrastRatio(colors.foreground, colors.background)).toBeGreaterThan(
		4.5
	);
});

test("model planning failure produces a deterministic local fallback and Save & exit does not create a project", async ({
	page,
}) => {
	const { companion } = await mountChecks(page);
	const target = await fixture(page);
	await companion.getByRole("button", { name: "Create Tests" }).click();
	await expect(
		companion.getByRole("button", { name: /Web \/ UI/ })
	).toHaveAttribute("aria-pressed", "true");
	await companion
		.getByRole("textbox", { name: "Project name" })
		.fill("Draft only");
	await companion
		.getByRole("textbox", { name: "Target URL" })
		.fill(target.projectUrl);
	await companion
		.getByRole("textbox", { name: /Product description or PRD/ })
		.fill(
			"Search for a fixture route and Checkout recovers from a billing error."
		);
	await companion.getByRole("button", { name: "Continue" }).click();
	await companion.getByRole("button", { name: "Continue" }).click();
	await page.evaluate(() => window.__checksProof.failNextModel());
	await companion.getByRole("button", { name: "Generate with Ryu AI" }).click();
	await expect(
		companion.getByText(
			"AI generation was unavailable; a deterministic plan was prepared from the brief."
		)
	).toBeVisible();
	await expect(
		companion.getByRole("checkbox", {
			name: "Keep Search returns an app detail page",
		})
	).toBeChecked();
	await expect(requests(await calls(page), "POST", "/projects")).toHaveLength(
		0
	);
	await capture(companion, "checks-companion-model-fallback-plan.png");
	await companion.getByRole("button", { name: "Save & exit" }).click();
	await expect(companion.getByRole("heading", { name: "Home" })).toBeVisible();
	await expect(requests(await calls(page), "POST", "/projects")).toHaveLength(
		0
	);
});

test("UI projects persist their surface, filter correctly, and run the local suite", async ({
	page,
}) => {
	const { companion } = await mountChecks(page);
	const target = await fixture(page);
	const project = await createProjectThroughWizard(page, companion, {
		name: "Checks UI Fixture",
		projectType: "UI",
		projectUrl: target.projectUrl,
		runtime: "agent",
		generatePlan: false,
		brief: "Exercise the local UI verification lane.",
	});
	expect(project.testIds).toHaveLength(3);
	const creation = requests(await calls(page), "POST", "/projects").at(-1);
	expect(creation?.body).toMatchObject({
		projectType: "UI",
		url: target.projectUrl,
	});

	await companion.getByRole("button", { name: "All Tests" }).click();
	await companion.getByRole("tab", { name: "UI tests" }).click();
	await expect(
		companion.getByText("Checks UI Fixture", { exact: true })
	).toBeVisible();
	await selectVisibleTab(companion, /API tests/);
	await expect(
		companion.getByText("Checks UI Fixture", { exact: true })
	).toHaveCount(0);
	await selectVisibleTab(companion, /UI tests/);
	await clearTargetRequests(page);
	await companion
		.getByRole("button", { name: "Run Checks UI Fixture" })
		.click();
	await expect(
		companion.getByText("Checks UI Fixture passed with live evidence.")
	).toBeVisible();
	const run = requests(
		await calls(page),
		"POST",
		`/projects/${project.projectId}/runs`
	).at(-1);
	expect(run?.status).toBe(200);
	expect(run?.body).toEqual({ trigger: "manual" });
	// This harness grants no browser.control capability, so the UI cases pass
	// over HTTP and the run is labeled as the honest browser fallback.
	expect(run?.result).toMatchObject({
		evidenceLevel: "live-http-fallback",
		failed: 0,
		passed: 3,
	});
	expect(await targetRequests(page)).toHaveLength(4);
	await capture(companion, "checks-companion-ui-project-run.png");
});

test("Checks create wizard retries project persistence and keeps exact planning input", async ({
	page,
}) => {
	const { companion, tenantUserId } = await mountChecks(page);
	const target = await fixture(page);
	const created = await createProjectThroughWizard(page, companion, {
		name: "Checks Mixed Fixture",
		projectType: "Mixed",
		projectUrl: target.projectUrl,
		runtime: "model",
		generatePlan: true,
		discoveryFailure: true,
		backThroughExplore: true,
		brief: "Verify sign-in, search, and checkout recovery at the local target.",
		extraContext: " Acceptance: only the local test host is contacted. ",
		contextFile: {
			name: "checks-acceptance.md",
			content: "Acceptance fixture: a local health response contains ok.\n",
		},
		createFailure: true,
	});
	const projectWrites = requests(await calls(page), "POST", "/projects");
	expect(projectWrites.map((call) => call.status)).toEqual([503, 200]);
	expect(projectWrites[0]?.body).toEqual(projectWrites[1]?.body);
	expect(projectWrites[1]?.body).toEqual({
		contextSources: [
			{
				kind: "notes",
				label: "Additional context",
				value: "Acceptance: only the local test host is contacted.",
			},
			{
				kind: "file",
				label: "checks-acceptance.md",
				value: "Acceptance fixture: a local health response contains ok.\n",
			},
		],
		description:
			"Verify sign-in, search, and checkout recovery at the local target.",
		name: "Checks Mixed Fixture",
		projectType: "Mixed",
		runtimeSelection: {
			kind: "model",
			modelId: "checks-fixture-model",
			providerId: "checks-fixture-provider",
		},
		testNames: [
			"Returning user signs in and reaches dashboard",
			"Search returns a matching product",
		],
		url: target.projectUrl,
	});
	expect(projectWrites[1]?.tenantUserId).toBe(tenantUserId);
	expect(projectWrites[1]?.orgId).toBe("checks-proof-org");
	const modelCalls = (
		await page.evaluate(() => window.__checksProof.hostCalls())
	).filter((call) => call.method === "model.complete");
	expect(modelCalls).toHaveLength(1);
	expect(modelCalls[0]?.input).toMatchObject({
		model: "checks-fixture-model",
		provider: "checks-fixture-provider",
	});
	const hostCalls = await page.evaluate(() => window.__checksProof.hostCalls());
	expect(hostCalls.filter((call) => call.method === "catalog.models")).toEqual([
		{
			input: { providerId: "checks-fixture-provider" },
			method: "catalog.models",
		},
		{
			input: { providerId: "checks-fixture-provider" },
			method: "catalog.models",
		},
	]);
	expect(created.testIds).toHaveLength(2);
	await expect(
		companion.getByRole("heading", { name: "What this project plans to prove" })
	).toBeVisible();
	await expect(
		companion.getByRole("option", {
			name: /Returning user signs in and reaches dashboard/,
		})
	).toBeVisible();
	await expect(
		companion.getByRole("option", {
			name: /Search returns a matching product/,
		})
	).toBeVisible();
	await capture(companion, "checks-companion-project-created.png");
});
