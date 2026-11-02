import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { z } from "zod";
import type {} from "./harness/checks-companion-proof.tsx";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for checks-companion-proof.spec.ts and its part<N>- siblings, kept apart so each file stays under the token limit.

export const APP_HTML = `${tmpdir()}/ryu-checks-companion-ui-build/index.html`;
export const EVIDENCE = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export type ChecksCall = Omit<
	ReturnType<Window["__checksProof"]["calls"]>[number],
	"body"
> & { body?: ReturnType<typeof JSON.parse> };

export interface ChecksFixture {
	projectUrl: string;
}

export async function mountChecks(
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

export async function fixture(page: Page): Promise<ChecksFixture> {
	const response = await page.request.get("/__proof/fixtures");
	expect(response.status()).toBe(200);
	return await response.json();
}

export async function targetRequests(
	page: Page
): Promise<Array<{ method: string; path: string }>> {
	const response = await page.request.get("/__proof/target-requests");
	expect(response.status()).toBe(200);
	return await response.json();
}

export async function clearTargetRequests(page: Page): Promise<void> {
	const response = await page.request.post("/__proof/clear-target-requests");
	expect(response.status()).toBe(200);
}

export async function selectVisibleTab(
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

export async function calls(page: Page): Promise<ChecksCall[]> {
	return await page.evaluate(() => window.__checksProof.calls());
}

export async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(EVIDENCE, { recursive: true });
	await companion.locator("body").screenshot({
		animations: "disabled",
		path: path.join(EVIDENCE, filename),
	});
}

export function linearLuminance(channels: readonly number[]): number {
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

export function contrastRatio(
	foreground: readonly number[],
	background: readonly number[]
): number {
	const values = [
		linearLuminance(foreground),
		linearLuminance(background),
	].sort((left, right) => right - left);
	return (values[0] + 0.05) / (values[1] + 0.05);
}

export async function selectRuntime(
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

export async function createProjectThroughWizard(
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

export function requests(
	allCalls: ChecksCall[],
	method: string,
	requestPath: string
) {
	return allCalls.filter(
		(call) => call.method === method && call.path === requestPath
	);
}
