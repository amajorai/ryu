import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { z } from "zod";
import { proofEvidencePath } from "./proof-evidence-path.ts";

export const evidenceDir = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

export interface MediaCall {
	input: {
		prompt?: string;
		provider?: string;
		model?: string;
		count?: number;
		request_id: string;
		project_id: string;
		text?: string;
		speed?: number;
		voice?: string;
		language?: string;
	};
	kind: string;
}

export function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

export function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/__studio/")) {
			return;
		}
		const body = request.postData();
		let parsedBody: unknown;
		if (body) {
			try {
				parsedBody = JSON.parse(body);
			} catch {
				parsedBody = body;
			}
		}
		requests.push({
			...(parsedBody === undefined ? undefined : { body: parsedBody }),
			method: request.method(),
			path: url.pathname.slice("/__studio".length),
		});
	});
	return requests;
}

export async function createProject(page: Page, title: string) {
	await page.goto("/");
	await expect(page.getByRole("status")).toContainText(
		"Project library connected."
	);
	await page.getByRole("button", { name: "New project" }).click();
	await expect(page.getByRole("status")).toContainText("Project created.");
	const titleField = page
		.locator(".studio-inspector .ryu-app-field")
		.first()
		.locator("input");
	await titleField.fill(title);
	await page.getByRole("button", { name: "Save changes" }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

export async function openGenerationPanel(page: Page) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill("Generate");
	const tab = page.locator('[data-tabs-menu-key="string:generate"]');
	await expect(tab).toBeVisible();
	await tab.click();
	await expect(
		page.getByRole("heading", { name: "Generate with Ryu" })
	).toBeVisible();
}

export function appField(page: Page, label: string) {
	return page
		.locator(".ryu-app-field")
		.filter({ hasText: label })
		.locator("input, textarea")
		.first();
}

export async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}

export async function generationCalls(page: Page): Promise<MediaCall[]> {
	const response = await page.request.get("/__proof/state");
	expect(response.ok()).toBe(true);
	const state = z
		.object({
			calls: z.array(
				z.object({
					kind: z.string(),
					input: z.object({
						prompt: z.string().optional(),
						provider: z.string().optional(),
						model: z.string().optional(),
						count: z.number().optional(),
						request_id: z.string(),
						project_id: z.string(),
						text: z.string().optional(),
						speed: z.number().optional(),
						voice: z.string().optional(),
						language: z.string().optional(),
					}),
				})
			),
		})
		.parse(await response.json());
	return state.calls;
}

export async function resetMediaFixture(page: Page) {
	const response = await page.request.post("/__proof/reset");
	expect(response.ok()).toBe(true);
}
