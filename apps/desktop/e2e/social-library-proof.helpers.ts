import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import type {
	Draft,
	DraftBody,
	MediaAsset,
	Template,
	Workspace,
} from "../../../apps-store/social/ui/src/types.ts";
import { parseProofJson } from "./fixture-json.ts";
import { proofEvidencePath } from "./proof-evidence-path.ts";

// Fixtures and helpers for social-library-proof.spec.ts, kept apart so each file stays under the token limit.

export const evidenceDirectory = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

export interface SocialRequest {
	body?: unknown;
	method: string;
	path: string;
	query: string;
}

declare global {
	interface Window {
		__socialLibraryProof?: {
			calls: Array<{ body?: unknown; method?: string; path: string }>;
			navigations: unknown[];
		};
	}
}

export function uniqueName(prefix: string) {
	return `${prefix} ${new Date().toISOString().replaceAll(":", "-")} ${crypto.randomUUID().slice(0, 8)}`;
}

export function recordSocialRequests(page: Page) {
	const requests: SocialRequest[] = [];
	page.on("request", (request) => {
		const url = new URL(request.url());
		if (!url.pathname.startsWith("/__social/")) {
			return;
		}
		const rawBody = request.postData();
		let body: unknown;
		if (rawBody) {
			try {
				body = parseProofJson(rawBody);
			} catch {
				body = rawBody;
			}
		}
		requests.push({
			...(body === undefined ? undefined : { body }),
			method: request.method(),
			path: url.pathname.slice("/__social".length),
			query: url.search,
		});
	});
	return requests;
}

export async function createWorkspace(
	page: Page,
	name: string
): Promise<Workspace> {
	const response = await page.request.post("/__social/workspaces", {
		data: { name },
	});
	expect(response.ok()).toBe(true);
	return await response.json();
}

export async function seedDraft(
	page: Page,
	workspaceId: string,
	text: string
): Promise<Draft> {
	const body: DraftBody = {
		account_ids: [],
		media: [],
		schema_version: 2,
		segments: [{ media: [], text }],
		text,
	};
	const response = await page.request.post("/__social/drafts", {
		data: { body, workspace_id: workspaceId },
	});
	expect(response.ok()).toBe(true);
	return await response.json();
}

export async function listDrafts(
	page: Page,
	workspaceId: string
): Promise<Draft[]> {
	const response = await page.request.get(
		`/__social/drafts?workspace_id=${encodeURIComponent(workspaceId)}`
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.drafts;
}

export async function listTemplates(
	page: Page,
	workspaceId: string
): Promise<Template[]> {
	const response = await page.request.get(
		`/__social/templates?workspace_id=${encodeURIComponent(workspaceId)}`
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.templates;
}

export async function listMedia(
	page: Page,
	workspaceId: string
): Promise<MediaAsset[]> {
	const response = await page.request.get(
		`/__social/media?workspace_id=${encodeURIComponent(workspaceId)}`
	);
	expect(response.ok()).toBe(true);
	const result = await response.json();
	return result.media;
}

export async function openLibrary(page: Page, workspaceId: string) {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
	if (workspaceId !== "default") {
		await page.getByLabel("Workspace").selectOption(workspaceId);
		await expect(page.getByLabel("Workspace")).toHaveValue(workspaceId);
	}
	await expect(page.getByRole("tab", { name: /Drafts/ })).toBeVisible();
}

export async function selectLibraryTab(page: Page, label: string, key: string) {
	const moreMenu = page.locator(
		'[data-tabs-more-trigger="true"][data-tabs-more-visible="true"]'
	);
	if ((await moreMenu.count()) > 0) {
		// Responsive TabsList can visually clip a trigger while it remains in the
		// DOM. When the More menu exists, use it as the reliable interaction route
		// for both visible and overflowed tabs.
		await moreMenu.first().click();
		const menuItem = page.locator(`[data-tabs-menu-key="string:${key}"]`);
		await expect(menuItem).toBeVisible();
		await menuItem.click();
	} else {
		await page.getByRole("tab", { name: new RegExp(label) }).click();
	}
	await expect(
		page.getByRole("tabpanel", { name: new RegExp(label) })
	).toBeVisible();
}

export function draftRow(page: Page, text: string) {
	return page
		.locator("div.rounded-lg.border.bg-card.p-3")
		.filter({ has: page.getByText(text, { exact: true }) });
}

export function templateRow(page: Page, name: string) {
	return page
		.locator("div.rounded-lg.border.bg-card.p-3")
		.filter({ has: page.getByText(name, { exact: true }) });
}

export function mediaRow(page: Page, name: string) {
	return page
		.locator("div.rounded-lg.border.bg-card.p-3")
		.filter({ has: page.getByText(name, { exact: true }) });
}

export async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(evidenceDirectory, filename),
	});
}
