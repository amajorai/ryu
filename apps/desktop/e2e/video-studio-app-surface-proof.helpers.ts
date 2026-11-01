import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type { GenerationJob } from "../../../apps-store/video-studio/shared/generation.ts";
import type {
	Asset,
	Project,
} from "../../../apps-store/video-studio/shared/project.ts";
import { parseProofJson } from "./fixture-json.ts";

export const evidenceDir = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);

export interface StudioRequest {
	body?: unknown;
	method: string;
	path: string;
}

export interface RenderJob {
	error?: string;
	id: string;
	projectId: string;
	review?: { passed: boolean; checks: Array<{ id: string; message: string }> };
	revision: number;
	status: string;
}

export interface FixtureImageCall {
	count: number;
	model?: string;
	project_id: string;
	prompt: string;
	request_id: string;
}

declare global {
	interface Window {
		__videoStudioFixtureImageCalls?: FixtureImageCall[];
	}
}

export function uniqueTitle(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

export function recordStudioRequests(page: Page) {
	const requests: StudioRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (
			!url.pathname.startsWith("/__studio/") ||
			url.pathname.includes("/uploads")
		) {
			return;
		}
		const body = request.postData();
		let parsedBody: unknown;
		if (body) {
			try {
				parsedBody = parseProofJson(body);
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

export async function seedAsset(
	page: Page,
	fixture: "image" | "video",
	name: string
): Promise<Asset> {
	const fixtureResponse = await page.request.get(`/__proof/${fixture}`);
	expect(fixtureResponse.ok()).toBe(true);
	const bytes = await fixtureResponse.body();
	const start = await page.request.post("/__studio/uploads", {
		data: { name, size: bytes.byteLength },
	});
	expect(start.status()).toBe(201);
	const upload = await start.json();
	for (let offset = 0; offset < bytes.byteLength; offset += upload.chunkSize) {
		const response = await page.request.put(`/__studio/uploads/${upload.id}`, {
			data: {
				offset,
				data: bytes
					.subarray(offset, offset + upload.chunkSize)
					.toString("base64"),
			},
		});
		expect(response.ok()).toBe(true);
	}
	const finish = await page.request.post(
		`/__studio/uploads/${upload.id}/finish`
	);
	expect(finish.status()).toBe(201);
	const asset = await finish.json();
	expect(asset).toMatchObject({ name, kind: fixture });
	return asset;
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
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
	return page.getByLabel("Project", { exact: true }).inputValue();
}

export async function selectProject(page: Page, projectId: string) {
	await page.getByLabel("Project", { exact: true }).selectOption(projectId);
	await expect(page.getByLabel("Project", { exact: true })).toHaveValue(
		projectId
	);
}

export async function openOverflowTab(
	page: Page,
	label: string,
	value: string
) {
	await page.getByRole("button", { name: /Show \d+ more tabs/ }).click();
	await page.getByRole("combobox", { name: "Search tabs" }).fill(label);
	const tab = page.locator(`[data-tabs-menu-key="string:${value}"]`);
	await expect(tab).toBeVisible();
	await tab.click();
}

export function assetRow(page: Page, name: string) {
	return page
		.locator(".studio-asset")
		.filter({ has: page.getByText(name, { exact: true }) });
}

export async function readProject(
	page: Page,
	projectId: string
): Promise<Project> {
	const response = await page.request.get(`/__studio/projects/${projectId}`);
	expect(response.ok()).toBe(true);
	return await response.json();
}

export async function readAssets(page: Page): Promise<Asset[]> {
	const response = await page.request.get("/__studio/assets");
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.assets;
}

export async function readAnalysis(page: Page, assetId: string) {
	const response = await page.request.get(
		`/__studio/assets/${assetId}/analysis`
	);
	expect(response.ok()).toBe(true);
	return await response.json();
}

export async function readGenerationJobs(
	page: Page,
	projectId: string
): Promise<GenerationJob[]> {
	const response = await page.request.get(
		`/__studio/generations?projectId=${projectId}`
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.jobs;
}

export async function readRenderJobs(page: Page): Promise<RenderJob[]> {
	const response = await page.request.get("/__studio/renders");
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.jobs;
}

export async function fillNumber(page: Page, label: string, value: string) {
	const field = page.getByRole("spinbutton", { name: label, exact: true });
	await field.fill(value);
	await field.press("Tab");
	await expect(field).toHaveValue(value);
}

export async function saveProject(page: Page) {
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByRole("status")).toContainText("Project saved.");
}

export async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDir, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDir, filename),
	});
}
