import { mkdir } from "node:fs/promises";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { z } from "zod";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for project-picker-proof.spec.ts, kept apart so each file stays under the token limit.

export const STORY_URL = "/project-picker-proof.html";
export const EVIDENCE_DIR = `${proofEvidencePath("test-coverage-sweep-20260924/evidence")}/`;
export const HOME_PATH = "/fixture/home";
export const PROJECTS_PATH = `${HOME_PATH}/Projects`;
export const ALPHA_PATH = `${PROJECTS_PATH}/alpha`;
export const BETA_PATH = `${PROJECTS_PATH}/beta`;

export const REQUESTS_KEY = "proof:project-picker:requests";

export interface FixtureRequest {
	body: unknown;
	hasAuthorization: boolean;
	method: string;
	origin: string;
	path: string;
	status: number;
}

declare global {
	interface Window {
		__projectPickerProof?: { requests: () => FixtureRequest[] };
	}
}

export const browserErrors = new WeakMap<Page, string[]>();

export async function openPage(
	page: Page,
	options: { active?: "alpha"; empty?: boolean; remote?: boolean } = {}
) {
	const query = new URLSearchParams({ reset: "1" });
	if (options.active) {
		query.set("active", options.active);
	}
	if (options.empty) {
		query.set("empty", "1");
	}
	if (options.remote) {
		query.set("node", "remote");
	}
	await page.setViewportSize({ height: 900, width: 1440 });
	await page.goto(`${STORY_URL}?${query.toString()}`);
	await expect(page).toHaveURL(/project-picker-proof\.html/);
	await expect(page).toHaveTitle("Project picker proof");
	await expect(page.getByTestId("project-picker-proof")).toBeVisible();
	await expect(
		page.getByRole("dialog", { name: "Choose a project to edit" })
	).toBeVisible();
}

export async function openProjectMenu(page: Page) {
	const trigger = page.getByRole("button", {
		name: "Select project folder",
	});
	await trigger.click();
	const menu = page.getByRole("dialog", {
		name: "Choose a project",
		exact: true,
	});
	await expect(menu).toBeVisible();
	return { menu, trigger };
}

export async function requests(page: Page): Promise<FixtureRequest[]> {
	const raw = await page.evaluate(
		(key) => localStorage.getItem(key),
		REQUESTS_KEY
	);
	return z
		.array(
			z.object({
				body: z.json(),
				hasAuthorization: z.boolean(),
				method: z.string(),
				origin: z.string(),
				path: z.string(),
				status: z.number(),
			})
		)
		.parse(raw ? JSON.parse(raw) : []);
}

export async function storedValue(
	page: Page,
	key: string
): Promise<string | null> {
	return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

export function apiRequests(
	items: FixtureRequest[],
	method: string,
	path: string
): FixtureRequest[] {
	return items.filter((item) => item.method === method && item.path === path);
}

export async function capture(
	page: Page,
	testInfo: TestInfo,
	filename: string
) {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	const screenshot = await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: `${EVIDENCE_DIR}${filename}`,
	});
	await testInfo.attach(filename, {
		body: screenshot,
		contentType: "image/png",
	});
}
