// Shared fixtures for the Sites Companion proof specs
// (sites-companion-proof*.spec.ts): the host proof API, its recorded calls and
// state, and the create-site flow every spec drives.
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type FrameLocator, type Page } from "@playwright/test";
import { proofEvidencePath } from "../proof-evidence-path.ts";
import type {
	SitesCall,
	SitesProofApi,
} from "./sites-companion-proof.types.ts";

const appHtmlPath = `${tmpdir()}/ryu-sites-companion-ui-build/index.html`;
export const evidenceDirectory = proofEvidencePath(
	"test-coverage-sweep-20260924/evidence"
);

interface SiteVersion {
	bytes: number;
	createdAt: string;
	id: string;
	message: string;
}

interface SiteSettings {
	agentActions: boolean;
	ai: boolean;
	aiDailyLimit: number;
	audience: string;
	editors: string[];
	mode: string;
	optionalSignIn: boolean;
	spaceId: string | null;
	storage: boolean;
	uploads: boolean;
	viewers: string[];
	workspaceId: string | null;
}

export interface SiteRecord {
	aliases: string[];
	deploymentId: string | null;
	domains: Array<{
		host: string;
		status: string;
		verification: string;
	}>;
	id: string;
	name: string;
	prompt: string;
	revision: number;
	settings: SiteSettings;
	slug: string;
	template: string;
	versions: SiteVersion[];
}

export interface SitesState {
	observations: {
		answerCalls: Array<{ query: string; siteId: string; spaceId: string }>;
		retrievalCalls: Array<{ query: string; siteId: string; spaceId: string }>;
		scanCalls: Array<{ digest: string; html: string }>;
		resetActionCalls: Array<{
			ownerId: string;
			provider: string;
			siteId: string;
		}>;
	};
	options: {
		agentAvailable: boolean;
		answersAvailable: boolean;
		approvedSpaceId: string;
		edgeAvailable: boolean;
		identityAvailable: boolean;
		publicEnabled: boolean;
		retrievalAvailable: boolean;
		scannerAvailable: boolean;
		scannerMode: "pass" | "unavailable";
	};
	projects: SiteRecord[];
}

declare global {
	interface Window {
		__sitesProof: SitesProofApi;
	}
}

export async function resetProof(
	page: Page,
	options?: Partial<SitesState["options"]>
): Promise<void> {
	const response = await page.request.post("/__proof/reset", {
		data: options ? { options } : {},
	});
	expect(response.status()).toBe(200);
}

export async function openHost(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
}

export async function mountSites(page: Page): Promise<FrameLocator> {
	const appHtml = await readFile(appHtmlPath, "utf8");
	await page.evaluate(
		(html) => window.__sitesProof.mount({ appHtml: html }),
		appHtml
	);
	await expect
		.poll(() => page.evaluate(() => window.__sitesProof.connected()), {
			timeout: 15_000,
		})
		.toBe(true);
	return page.frameLocator('iframe[title="Sites proof"]');
}

export async function mountFreshSites(
	page: Page,
	options?: Partial<SitesState["options"]>
): Promise<FrameLocator> {
	await resetProof(page, options);
	await openHost(page);
	const companion = await mountSites(page);
	await expect(companion.getByTestId("sites-app")).toBeVisible();
	return companion;
}

export async function calls(page: Page): Promise<SitesCall[]> {
	return await page.evaluate(() => window.__sitesProof.calls());
}

export async function waitForCall(
	page: Page,
	method: string,
	pathName: string,
	index = -1
): Promise<SitesCall> {
	await expect
		.poll(
			async () =>
				(await calls(page))
					.filter((call) => call.method === method && call.path === pathName)
					.at(index)?.status ?? 0
		)
		.toBeGreaterThan(0);
	const found = (await calls(page))
		.filter((call) => call.method === method && call.path === pathName)
		.at(index);
	if (!found) {
		throw new Error(
			`No captured Sites ${method} ${pathName} request was recorded.`
		);
	}
	return found;
}

export async function state(page: Page): Promise<SitesState> {
	const response = await page.request.get("/__proof/state");
	expect(response.status()).toBe(200);
	return await response.json();
}

export async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(evidenceDirectory, { recursive: true });
	await companion.locator("body").screenshot({
		path: path.join(evidenceDirectory, filename),
	});
}

export function fieldControl(
	companion: FrameLocator,
	label: string,
	selector: "input" | "textarea" = "input"
) {
	return companion
		.getByText(label, { exact: true })
		.locator("..")
		.locator(selector);
}

export async function createSite(
	companion: FrameLocator,
	page: Page,
	input: {
		name: string;
		slug?: string;
		template?:
			| "website"
			| "help-center"
			| "dashboard"
			| "game"
			| "reset-calendar";
		prompt?: string;
	}
): Promise<SiteRecord> {
	const createIndex = (await calls(page)).filter(
		(call) => call.method === "POST" && call.path === "/projects"
	).length;
	await companion
		.getByRole("button", { name: "New site", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Create a site" })
	).toBeVisible();
	await dialog.getByLabel("Site name", { exact: true }).fill(input.name);
	const slugField = dialog.getByLabel("URL name", { exact: true });
	if (input.slug) {
		await slugField.fill(input.slug);
	}
	if (input.template && input.template !== "help-center") {
		await dialog.getByRole("combobox", { name: "Template" }).click();
		await companion
			.getByRole("option", { name: input.template, exact: true })
			.click();
	}
	await dialog
		.getByLabel("Description", { exact: true })
		.fill(input.prompt ?? "Fixture description");
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	await expect(companion.getByLabel("What should change?")).toBeVisible();
	const createdCall = await waitForCall(page, "POST", "/projects", createIndex);
	expect(createdCall.status).toBe(201);
	const allSites = await state(page);
	const created = allSites.projects.find(
		(site) =>
			site.slug ===
			(input.slug ??
				input.name
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.replace(/^-|-$/g, ""))
	);
	if (!created) {
		throw new Error(
			`Created Site ${input.name} is missing from the real sidecar store.`
		);
	}
	return created;
}

export async function setScannerMode(
	page: Page,
	scannerMode: "pass" | "unavailable"
): Promise<void> {
	const response = await page.request.post("/__proof/options", {
		data: { scannerMode },
	});
	expect(response.status()).toBe(200);
}
