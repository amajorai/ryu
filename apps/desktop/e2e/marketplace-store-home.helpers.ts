// Navigation, evidence and hook helpers shared by the Store home specs.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	API_ORIGIN,
	EVIDENCE_DIR,
	engineDiagnostics,
	type Fixture,
	STORY_URL,
} from "./marketplace-store-home.fixture.ts";
import { installLocalFixture } from "./marketplace-store-home.routes.ts";

export async function openHome(page: Page): Promise<Fixture> {
	const fixture = await installLocalFixture(page);
	await page.goto(STORY_URL);
	await expect(page.getByRole("heading", { name: "For you" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home GGUF Candidate" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home Skill Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home MCP Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Home Agent Fixture" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Fixture Home App" })
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Fixture Home Plugin" })
	).toBeVisible();
	return fixture;
}

export async function openStoreSection(
	page: Page,
	section: "apps" | "engines" | "plugins" | "skills" | "mcp"
): Promise<Fixture> {
	const fixture = await installLocalFixture(
		page,
		API_ORIGIN,
		section === "engines"
	);
	await page.goto(`${STORY_URL}?section=${section}`);
	const selectedTab = page.getByRole("tab", { selected: true });
	await expect(selectedTab).toContainText(
		{
			apps: "Apps",
			engines: "Engines",
			plugins: "Plugins",
			skills: "Skills",
			mcp: "MCP",
		}[section]
	);
	if (section === "engines") {
		await expect(page.getByRole("button", { name: "llama.cpp" })).toBeVisible();
	}
	return fixture;
}

export function callsFor(fixture: Fixture, method: string, path: string) {
	return fixture.calls.filter(
		(call) => call.method === method && call.path === path
	);
}

export async function prepareEvidenceCapture(page: Page) {
	const indicator = page.locator('[data-slot="tabs-indicator"]');
	if (await indicator.count()) {
		await indicator.evaluateAll(async (elements) => {
			await Promise.all(
				elements.flatMap((element) =>
					element
						.getAnimations()
						.map((animation) => animation.finished.catch(() => undefined))
				)
			);
		});
	}
	await page.evaluate(() => {
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
	});
	await page.mouse.move(1430, 990);
}

/**
 * Adding or installing a skill changes the enabled skill set, which resets the
 * prompt cache of every thread, so the Store asks before it writes
 * (useSkillsCatalog, 4f7563c79d). Asserts nothing reached `installPath` while
 * the question was open, then applies.
 */
export async function confirmSkillSetChange(
	page: Page,
	fixture: Fixture,
	installPath: string
): Promise<void> {
	const writes = callsFor(fixture, "POST", installPath).length;
	const dialog = page.getByRole("alertdialog", {
		name: "Apply now? This resets the prompt cache",
	});
	await expect(dialog).toBeVisible();
	expect(callsFor(fixture, "POST", installPath)).toHaveLength(writes);
	await dialog.getByRole("button", { name: "Apply now", exact: true }).click();
	await expect(dialog).toBeHidden();
}

export function deferred() {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	return { promise, release };
}

export function registerStoreHomeEvidenceHooks(): void {
	test.afterEach(async ({ page }, testInfo) => {
		const diagnostic = engineDiagnostics.get(page);
		if (!diagnostic) {
			return;
		}
		const name = testInfo.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
		const completed = testInfo.status === testInfo.expectedStatus;
		let dialogGeometry: { opacity: string; width: number; height: number }[] =
			[];
		if (completed) {
			await page.evaluate(() => document.fonts.ready);
			const dialogs = page.getByRole("dialog");
			for (const dialog of await dialogs.all()) {
				await expect(dialog).toHaveCSS("opacity", "1");
			}
			dialogGeometry = await dialogs.evaluateAll((elements) =>
				elements.map((element) => {
					const bounds = element.getBoundingClientRect();
					return {
						opacity: getComputedStyle(element).opacity,
						width: bounds.width,
						height: bounds.height,
					};
				})
			);
			await page.screenshot({
				path: resolve(EVIDENCE_DIR, `${name}-completed.png`),
				fullPage: true,
				animations: "disabled",
			});
		}
		writeFileSync(
			resolve(EVIDENCE_DIR, `${name}-contracts.json`),
			JSON.stringify(
				{
					calls: diagnostic.fixture.calls,
					unknown: diagnostic.unknown,
					pageErrors: diagnostic.pageErrors,
					completed,
					dialogGeometry,
				},
				null,
				2
			)
		);
		if (diagnostic.unknown.length || diagnostic.pageErrors.length) {
			await page.screenshot({
				path: resolve(EVIDENCE_DIR, `${name}-contract-failure.png`),
				fullPage: true,
			});
		}
		expect(
			diagnostic.unknown,
			"Engines must not depend on unrecognized successful API fixtures"
		).toEqual([]);
		expect(
			diagnostic.pageErrors,
			"Engines production callers must not throw uncaught errors"
		).toEqual([]);
	});

	// Retain the rendered failure state for the focused Engine diagnostics.
	test.afterEach(async ({ page }, testInfo) => {
		if (
			testInfo.status === testInfo.expectedStatus ||
			!/Engines list|llama\.cpp acceleration/.test(testInfo.title)
		) {
			return;
		}
		await testInfo.attach("engine-render-state", {
			body: await page.locator("body").innerText(),
			contentType: "text/plain",
		});
		await page.screenshot({
			path: testInfo.outputPath("engine-render-state.png"),
			fullPage: true,
		});
		console.info(
			"Engine rendered state:",
			await page.locator("body").innerText()
		);
	});
}
