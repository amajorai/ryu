import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import { z } from "zod";
import {
	capturedJsonArray,
	capturedJsonField,
} from "./captured-json-observations.ts";
import type {} from "./harness/checks-companion-proof.tsx";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_HTML = `${tmpdir()}/ryu-checks-companion-ui-build/index.html`;
const EVIDENCE = path.resolve(
	HERE,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

type ChecksCall = Omit<
	ReturnType<Window["__checksProof"]["calls"]>[number],
	"body"
> & { body?: ReturnType<typeof JSON.parse> };

interface ChecksFixture {
	projectUrl: string;
}

async function mountChecks(
	page: Page,
	input: { screen?: string; tenantUserId?: string } = {}
): Promise<{ companion: FrameLocator; tenantUserId: string }> {
	const tenantUserId = input.tenantUserId ?? `checks-proof-${randomUUID()}`;
	await page.goto("/checks-companion-proof.html");
	await page.waitForSelector("body[data-harness-ready='1']");
	await page.evaluate(
		({ appHtml, screen, userId }) =>
			window.__checksProof.mount({
				appHtml,
				orgId: "checks-proof-org",
				screen,
				tenantUserId: userId,
			}),
		{
			appHtml: readFileSync(APP_HTML, "utf8"),
			screen: input.screen ?? "home",
			userId: tenantUserId,
		}
	);
	await expect
		.poll(() => page.evaluate(() => window.__checksProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	return { companion: page.frameLocator("iframe"), tenantUserId };
}

async function fixture(page: Page): Promise<ChecksFixture> {
	const response = await page.request.get("/__proof/fixtures");
	expect(response.status()).toBe(200);
	return await response.json();
}

async function targetRequests(
	page: Page
): Promise<Array<{ method: string; path: string }>> {
	const response = await page.request.get("/__proof/target-requests");
	expect(response.status()).toBe(200);
	return await response.json();
}

async function clearTargetRequests(page: Page): Promise<void> {
	const response = await page.request.post("/__proof/clear-target-requests");
	expect(response.status()).toBe(200);
}

async function selectVisibleTab(
	companion: FrameLocator,
	name: RegExp
): Promise<void> {
	const tab = companion.getByRole("tab", { name });
	// The row has room for every tab, so none may collapse into "N more".
	await expect(
		companion
			.getByRole("tablist")
			.filter({ has: tab })
			.getByRole("button", { name: /Show \d+ more tabs/ })
	).toHaveCount(0);
	await tab.click();
}

async function calls(page: Page): Promise<ChecksCall[]> {
	return await page.evaluate(() => window.__checksProof.calls());
}

async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await companion.locator("body").screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

function linearLuminance(channels: readonly number[]): number {
	if (channels.length !== 3) {
		return 0;
	}
	const linear = channels.map((channel) => {
		const normalized = channel / 255;
		return normalized <= 0.040_45
			? normalized / 12.92
			: ((normalized + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(
	foreground: readonly number[],
	background: readonly number[]
): number {
	const values = [
		linearLuminance(foreground),
		linearLuminance(background),
	].sort((left, right) => right - left);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

async function selectRuntime(
	page: Page,
	companion: FrameLocator,
	kind: "agent" | "model",
	discoveryFailure = false
): Promise<void> {
	await companion
		.getByRole("combobox", { name: "Choose a Ryu model or agent" })
		.click();
	if (kind === "agent") {
		await companion
			.getByRole("option", { name: /Checks Fixture Agent/ })
			.click();
		return;
	}
	if (discoveryFailure) {
		await page.evaluate(() => window.__checksProof.failNextDiscovery());
	}
	await companion
		.getByRole("option", {
			name: /Checks Local Fixture checks-fixture-provider/,
		})
		.click();
	if (discoveryFailure) {
		await expect(
			companion.getByText("Model discovery failed. Try again.")
		).toBeVisible();
		await companion.getByRole("button", { name: "Retry discovery" }).click();
	}
	await companion.getByRole("option", { name: "Checks Fixture Model" }).click();
}

async function createProjectThroughWizard(
	page: Page,
	companion: FrameLocator,
	input: {
		name: string;
		projectType: "API" | "Mixed" | "UI";
		projectUrl: string;
		runtime: "agent" | "model";
		generatePlan?: boolean;
		brief?: string;
		extraContext?: string;
		contextFile?: { name: string; content: string };
		discoveryFailure?: boolean;
		backThroughExplore?: boolean;
		createFailure?: boolean;
	}
): Promise<{ projectId: string; testIds: string[] }> {
	await companion
		.getByRole("button", { name: /Create Tests|New project/ })
		.click();
	await companion
		.getByRole("textbox", { name: "Project name" })
		.fill(input.name);
	await companion
		.getByRole("textbox", { name: "Target URL" })
		.fill(input.projectUrl);
	const projectTypeButton = companion.getByRole("button", {
		name:
			input.projectType === "API"
				? /Backend \/ API/
				: input.projectType === "Mixed"
					? "Mixed"
					: /Web \/ UI/,
	});
	await projectTypeButton.click();
	await expect(projectTypeButton).toHaveAttribute("aria-pressed", "true");
	await selectRuntime(page, companion, input.runtime, input.discoveryFailure);
	await companion
		.getByRole("textbox", { name: /Product description or PRD/ })
		.fill(
			input.brief ??
				"Users can sign in, search for an app, open its detail page, and recover from a failed checkout."
		);
	if (input.contextFile) {
		await companion.locator('input[type="file"]').setInputFiles({
			name: input.contextFile.name,
			mimeType: "text/markdown",
			buffer: Buffer.from(input.contextFile.content),
		});
		await expect(companion.getByText(/1 context file attached/)).toBeVisible();
	}
	if (input.extraContext) {
		await companion
			.getByRole("textbox", { name: /Additional context/ })
			.fill(input.extraContext);
	}
	await companion.getByRole("button", { name: "Continue" }).click();
	await expect(companion.getByText("Queued live exploration")).toBeVisible();
	if (input.backThroughExplore) {
		await companion.getByRole("button", { name: "Back" }).click();
		await expect(
			companion.getByRole("textbox", { name: "Project name" })
		).toHaveValue(input.name);
		await companion.getByRole("button", { name: "Continue" }).click();
	}
	await companion.getByRole("button", { name: "Continue" }).click();
	if (input.generatePlan !== false) {
		await companion
			.getByRole("button", { name: "Generate with Ryu AI" })
			.click();
		await expect(
			companion.getByText("Ryu AI generated 3 observable cases.")
		).toBeVisible();
		if (input.generatePlan === true) {
			await companion
				.getByRole("checkbox", {
					name: "Keep Checkout recovers after a billing error",
				})
				.uncheck();
			await expect(companion.getByText("2 selected")).toBeVisible();
		}
	}
	await companion.getByRole("button", { name: "Continue" }).click();
	await expect(
		companion.getByText("Ready to add a local project")
	).toBeVisible();
	if (input.createFailure) {
		await page.evaluate(() => {
			window.__checksProof.failNext({
				message: "Fixture rejected the first project write.",
				method: "POST",
				path: "/projects",
				status: 503,
			});
		});
		await companion.getByRole("button", { name: "Create project" }).click();
		await expect(
			companion.getByText("Fixture rejected the first project write.")
		).toBeVisible();
		await expect(
			companion.getByRole("button", { name: "Create project" })
		).toBeEnabled();
	}
	await companion.getByRole("button", { name: "Create project" }).click();
	await expect(
		companion.getByRole("heading", { name: input.name })
	).toBeVisible();
	const projectWrite = requests(await calls(page), "POST", "/projects").at(-1);
	const result = z
		.object({
			project: z.object({ id: z.string() }),
			tests: z.array(z.object({ id: z.string() })),
		})
		.parse(projectWrite?.result);
	if (!(result?.project?.id && result.tests)) {
		throw new Error(
			"The Checks sidecar did not return the created project and tests."
		);
	}
	return {
		projectId: result.project.id,
		testIds: result.tests.map((test) => test.id),
	};
}

function requests(allCalls: ChecksCall[], method: string, requestPath: string) {
	return allCalls.filter(
		(call) => call.method === method && call.path === requestPath
	);
}

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
		"Finished",
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
