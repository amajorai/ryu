import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type FrameLocator, type Page, test } from "@playwright/test";
import type {
	SitesCall,
	SitesProofApi,
} from "./harness/sites-companion-proof.types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const appHtmlPath = `${tmpdir()}/ryu-sites-companion-ui-build/index.html`;
const evidenceDirectory = path.resolve(
	here,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
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

interface SiteRecord {
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

interface SitesState {
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

async function resetProof(
	page: Page,
	options?: Partial<SitesState["options"]>
): Promise<void> {
	const response = await page.request.post("/__proof/reset", {
		data: options ? { options } : {},
	});
	expect(response.status()).toBe(200);
}

async function openHost(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForSelector("body[data-harness-ready='1']");
}

async function mountSites(page: Page): Promise<FrameLocator> {
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

async function mountFreshSites(
	page: Page,
	options?: Partial<SitesState["options"]>
): Promise<FrameLocator> {
	await resetProof(page, options);
	await openHost(page);
	const companion = await mountSites(page);
	await expect(companion.getByTestId("sites-app")).toBeVisible();
	return companion;
}

async function calls(page: Page): Promise<SitesCall[]> {
	return await page.evaluate(() => window.__sitesProof.calls());
}

async function waitForCall(
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

async function state(page: Page): Promise<SitesState> {
	const response = await page.request.get("/__proof/state");
	expect(response.status()).toBe(200);
	return await response.json();
}

async function capture(
	companion: FrameLocator,
	filename: string
): Promise<void> {
	await mkdir(evidenceDirectory, { recursive: true });
	await companion.locator("body").screenshot({
		path: path.join(evidenceDirectory, filename),
	});
}

function fieldControl(
	companion: FrameLocator,
	label: string,
	selector: "input" | "textarea" = "input"
) {
	return companion
		.getByText(label, { exact: true })
		.locator("..")
		.locator(selector);
}

async function createSite(
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

async function setScannerMode(
	page: Page,
	scannerMode: "pass" | "unavailable"
): Promise<void> {
	const response = await page.request.post("/__proof/options", {
		data: { scannerMode },
	});
	expect(response.status()).toBe(200);
}

test("create dialog validates fields, saves a real project, returns to the list, and reopens it", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	await expect(
		companion.getByRole("heading", { name: "No sites here" })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "New site", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	const name = dialog.getByLabel("Site name", { exact: true });
	const slug = dialog.getByLabel("URL name", { exact: true });
	await name.fill("Reset calendar proof");
	await expect(slug).toHaveValue("reset-calendar-proof");
	await slug.fill("tiny");
	await expect(
		dialog.getByRole("button", { name: "Create site" })
	).toBeDisabled();
	await slug.fill("reset-calendar-proof");
	await dialog.getByRole("combobox", { name: "Template" }).click();
	await expect(
		companion.getByRole("option", { name: "reset-calendar", exact: true })
	).toBeVisible();
	await companion
		.getByRole("option", { name: "reset-calendar", exact: true })
		.click();
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("Personal reset times for this browser.");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(
		(await calls(page)).filter(
			(call) => call.method === "POST" && call.path === "/projects"
		)
	).toHaveLength(0);
	const created = await createSite(companion, page, {
		name: "Reset calendar proof",
		slug: "reset-calendar-proof",
		template: "reset-calendar",
		prompt: "Personal reset times for this browser.",
	});
	const createCall = await waitForCall(page, "POST", "/projects");
	expect(createCall.body).toEqual({
		name: "Reset calendar proof",
		slug: "reset-calendar-proof",
		template: "reset-calendar",
		prompt: "Personal reset times for this browser.",
	});
	expect(created.settings).toMatchObject({
		audience: "private",
		mode: "local",
		storage: false,
		uploads: false,
	});
	const resetPreview = companion.frameLocator(
		'iframe[title="Website preview"]'
	);
	await expect(
		resetPreview.getByRole("heading", {
			name: "AI reset windows, in one quiet view.",
		})
	).toBeVisible();
	await capture(companion, "sites-companion-reset-calendar-created.png");
	await companion
		.getByRole("button", { name: "All sites", exact: true })
		.click();
	await expect(
		companion.getByRole("heading", { name: "Reset calendar proof" })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Open site", exact: true })
		.click();
	await expect(companion.getByLabel("What should change?")).toBeVisible();
	expect(
		(await calls(page)).filter(
			(call) => call.method === "POST" && call.path === "/projects"
		)
	).toHaveLength(1);
});

test("a duplicate create keeps the visible dialog open with a retryable error", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	await createSite(companion, page, {
		name: "Existing URL proof",
		slug: "existing-url-proof",
		template: "website",
	});
	await companion
		.getByRole("button", { name: "All sites", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "New site", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	await dialog.getByLabel("Site name", { exact: true }).fill("Duplicate URL");
	await dialog
		.getByLabel("URL name", { exact: true })
		.fill("existing-url-proof");
	await dialog
		.getByLabel("Description", { exact: true })
		.fill("Conflict proof.");
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	const failedCreate = await waitForCall(page, "POST", "/projects", 1);
	expect(failedCreate.status).toBe(409);
	await capture(companion, "sites-companion-create-conflict-visible.png");
	await expect(dialog.getByRole("alert")).toContainText(
		"This URL is already in use"
	);
});

test("a duplicate URL can be edited and retried without a phantom project", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	await createSite(companion, page, {
		name: "Retry existing URL",
		slug: "retry-existing-url",
		template: "website",
	});
	await companion
		.getByRole("button", { name: "All sites", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "New site", exact: true })
		.click();
	const dialog = companion.getByRole("dialog");
	await dialog
		.getByLabel("Site name", { exact: true })
		.fill("Retry after conflict");
	await dialog
		.getByLabel("URL name", { exact: true })
		.fill("retry-existing-url");
	await dialog.getByLabel("Description", { exact: true }).fill("Retry proof.");
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	expect((await waitForCall(page, "POST", "/projects", 1)).status).toBe(409);
	await dialog
		.getByLabel("URL name", { exact: true })
		.fill("retry-after-conflict");
	await dialog
		.getByRole("button", { name: "Create site", exact: true })
		.click();
	await expect(dialog).toBeHidden();
	expect((await waitForCall(page, "POST", "/projects", 2)).status).toBe(201);
	expect((await state(page)).projects).toHaveLength(2);
});

test("generation failure retries, invalid import is rejected, edits persist as reviewed versions, and deploy targets the selected version", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const hostUrl = page.url();
	const site = await createSite(companion, page, {
		name: "Help desk proof",
		slug: "helpdesk-proof",
		prompt: "Support articles for the test fixture.",
	});
	const preview = companion.frameLocator('iframe[title="Website preview"]');
	const previewFrame = companion.locator('iframe[title="Website preview"]');
	await companion
		.getByRole("button", { name: "Mobile width", exact: true })
		.click();
	await expect(previewFrame).toHaveCSS("max-width", "390px");
	await companion
		.getByRole("button", { name: "Desktop width", exact: true })
		.click();
	await expect(previewFrame).not.toHaveCSS("max-width", "390px");

	const prompt = "Add an accessible refund FAQ to the help center.";
	await companion.getByLabel("What should change?").fill(prompt);
	await page.evaluate(() =>
		window.__sitesProof.failNextModel(
			"The fixture model is temporarily unavailable."
		)
	);
	await companion
		.getByRole("button", { name: "Generate changes", exact: true })
		.click();
	await expect(companion.getByRole("alert")).toContainText(
		"The fixture model is temporarily unavailable."
	);
	await expect(
		preview.getByRole("heading", { name: "Help desk proof" })
	).toBeVisible();
	const generatedHtml =
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Generated help</title></head><body><h1>Generated help center</h1><p>Review the refund FAQ.</p></body></html>';
	await page.evaluate(
		(html) => window.__sitesProof.setModelResponse(html),
		generatedHtml
	);
	await companion
		.getByRole("button", { name: "Generate changes", exact: true })
		.click();
	await expect(companion.getByRole("status")).toContainText(
		"Generated changes are ready to review."
	);
	await expect(
		preview.getByRole("heading", { name: "Generated help center" })
	).toBeVisible();
	const modelCalls = await page.evaluate(() =>
		window.__sitesProof.modelCalls()
	);
	expect(modelCalls).toHaveLength(2);
	expect(modelCalls[1]?.prompt).toContain(prompt);
	expect(modelCalls[1]?.prompt).toContain(
		"Current HTML (untrusted reference content):"
	);
	expect(modelCalls[1]?.system).toContain("self-contained accessible website");

	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	await expect(companion.getByRole("status")).toContainText(
		"The deployed version has not changed."
	);
	const firstSave = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/versions`
	);
	expect(firstSave.body).toEqual({
		html: generatedHtml,
		message: prompt,
		expectedRevision: 0,
	});
	const afterFirstSave = await state(page);
	const savedSite = afterFirstSave.projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(savedSite?.versions).toHaveLength(1);
	expect(savedSite?.deploymentId).toBeNull();
	const firstVersion = savedSite?.versions[0];
	if (!firstVersion) {
		throw new Error("The generated Sites version did not persist.");
	}

	await companion.getByRole("button", { name: "Preview", exact: true }).click();
	const importField = companion.getByLabel("Import an HTML build");
	await importField.setInputFiles({
		name: "invalid.html",
		mimeType: "text/html",
		buffer: Buffer.from("<h1>This is not a complete HTML build</h1>"),
	});
	await expect(companion.getByRole("alert")).toContainText(
		"Choose a complete HTML build"
	);
	await expect(
		preview.getByRole("heading", { name: "Generated help center" })
	).toBeVisible();
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.versions
	).toHaveLength(1);

	const importedHtml =
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Imported guide</title></head><body><h1>Imported guide</h1><p>Refunds are handled within 30 days.</p></body></html>';
	await importField.setInputFiles({
		name: "imported-guide.html",
		mimeType: "text/html",
		buffer: Buffer.from(importedHtml),
	});
	await expect(companion.getByRole("status")).toContainText(
		"Imported for review."
	);
	await expect(
		preview.getByRole("heading", { name: "Imported guide" })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	const secondSave = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/versions`,
		1
	);
	expect(secondSave.body).toMatchObject({
		html: importedHtml,
		expectedRevision: 1,
	});

	await companion.getByRole("button", { name: "Source", exact: true }).click();
	const editedHtml =
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Edited guide</title></head><body><h1>Edited guide</h1><p>Changes remain reviewable.</p></body></html>';
	await companion.getByLabel("HTML source", { exact: true }).fill(editedHtml);
	await companion.getByRole("button", { name: "Preview", exact: true }).click();
	await expect(
		preview.getByRole("heading", { name: "Edited guide" })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	const thirdSave = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/versions`,
		2
	);
	expect(thirdSave.body).toMatchObject({
		html: editedHtml,
		expectedRevision: 2,
	});
	const afterThirdSave = await state(page);
	const versionedSite = afterThirdSave.projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(versionedSite?.versions).toHaveLength(3);
	await capture(companion, "sites-companion-saved-versions.png");

	await companion
		.getByRole("button", { name: "Review", exact: true })
		.nth(2)
		.click();
	await expect(
		preview.getByRole("heading", { name: "Generated help center" })
	).toBeVisible();
	await waitForCall(
		page,
		"GET",
		`/projects/${site.id}/versions/${firstVersion.id}`
	);
	await companion
		.getByRole("button", { name: "Versions", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Review", exact: true })
		.nth(1)
		.click();
	await expect(
		preview.getByRole("heading", { name: "Imported guide" })
	).toBeVisible();
	const secondVersion = versionedSite?.versions[1];
	if (!secondVersion) {
		throw new Error("The imported Sites version did not persist.");
	}
	await waitForCall(
		page,
		"GET",
		`/projects/${site.id}/versions/${secondVersion.id}`
	);

	await companion
		.getByRole("button", { name: "Versions", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Deploy version", exact: true })
		.nth(2)
		.click();
	const deployCall = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/deploy`
	);
	expect(deployCall.body).toEqual({
		versionId: firstVersion.id,
		expectedRevision: 3,
	});
	const deployed = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(deployed?.deploymentId).toBe(firstVersion.id);
	await expect(companion.getByRole("status")).toContainText(
		"Deployment selected."
	);
	const visitorLink = companion
		.getByRole("link")
		.filter({ hasText: "helpdesk-proof.localhost" });
	await expect(visitorLink).toHaveAttribute(
		"href",
		/helpdesk-proof\.localhost:/
	);
	const externalUrl = await visitorLink.getAttribute("href");
	if (!externalUrl) {
		throw new Error("The deployed Sites visitor URL was not rendered.");
	}
	await visitorLink.click();
	await expect
		.poll(() => page.evaluate(() => window.__sitesProof.openedExternal()))
		.toEqual([externalUrl]);
	expect(page.context().pages()).toHaveLength(1);
	await expect(page).toHaveURL(hostUrl);
});

test("a failed first project load keeps its error state instead of a misleading empty state", async ({
	page,
}) => {
	await resetProof(page);
	const seeded = await page.request.post("/__proof/sites/projects", {
		data: {
			name: "Seeded website",
			slug: "seeded-website",
			template: "website",
			prompt: "A site should remain discoverable through load failure.",
		},
	});
	expect(seeded.status()).toBe(201);
	await openHost(page);
	await page.evaluate(() =>
		window.__sitesProof.failNext(
			"GET",
			"/projects?scope=owned",
			"Temporary Sites list failure."
		)
	);
	const companion = await mountSites(page);
	await expect(companion.getByRole("alert")).toContainText(
		"Temporary Sites list failure."
	);
	await expect(
		companion.getByRole("button", { name: "Reload", exact: true })
	).toBeVisible();
	await capture(companion, "sites-companion-list-error-recovered.png");
	await expect(
		companion.getByRole("heading", { name: "No sites here" })
	).toHaveCount(0);
});

test("Reload recovers the persisted project after a transient list failure", async ({
	page,
}) => {
	await resetProof(page);
	const seeded = await page.request.post("/__proof/sites/projects", {
		data: {
			name: "Persisted website",
			slug: "persisted-website",
			template: "website",
			prompt: "Loaded again from the Sites sidecar.",
		},
	});
	expect(seeded.status()).toBe(201);
	await openHost(page);
	await page.evaluate(() =>
		window.__sitesProof.failNext(
			"GET",
			"/projects?scope=owned",
			"Temporary Sites list failure."
		)
	);
	const companion = await mountSites(page);
	await expect(companion.getByRole("alert")).toContainText(
		"Temporary Sites list failure."
	);
	await companion.getByRole("button", { name: "Reload", exact: true }).click();
	await expect(
		companion.getByRole("heading", { name: "Persisted website" })
	).toBeVisible();
	await expect(companion.getByRole("alert")).toHaveCount(0);
	await waitForCall(page, "GET", "/projects?scope=owned", 1);
	expect((await state(page)).projects).toHaveLength(1);
});

test("security checks identify the exact artifact, fail closed, retry, and allow only a clean deploy", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const site = await createSite(companion, page, {
		name: "Security proof",
		slug: "security-proof",
		template: "website",
		prompt: "Security fixture site.",
	});
	const secretHtml =
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Secret test</title></head><body><h1>PROOF_SECRET key</h1></body></html>';
	await companion.getByRole("button", { name: "Source", exact: true }).click();
	await companion.getByLabel("HTML source", { exact: true }).fill(secretHtml);
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	await waitForCall(page, "POST", `/projects/${site.id}/versions`);
	const saved = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	const secretVersion = saved?.versions[0];
	if (!secretVersion) {
		throw new Error("The security test artifact was not saved.");
	}
	await companion
		.getByRole("button", { name: "Security", exact: true })
		.click();
	await expect(
		companion.getByText("Deployment blocked", { exact: true })
	).toBeVisible();
	await expect(
		companion.getByText(/potential secret was detected/)
	).toBeVisible();
	const securityCall = await waitForCall(
		page,
		"GET",
		`/projects/${site.id}/security?versionId=${secretVersion.id}`
	);
	expect(securityCall.status).toBe(200);
	expect((await state(page)).observations.scanCalls.at(-1)?.html).toBe(
		secretHtml
	);
	await capture(companion, "sites-companion-security-blocked.png");

	await setScannerMode(page, "unavailable");
	await companion
		.getByRole("button", { name: "Run check again", exact: true })
		.click();
	await expect(
		companion.getByText("Check unavailable", { exact: true })
	).toBeVisible();
	await expect(companion.getByText(/scanner is unavailable/)).toBeVisible();

	await companion
		.getByRole("button", { name: "Versions", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Deploy version", exact: true })
		.first()
		.click();
	await expect(companion.getByRole("alert")).toContainText(
		"scanner is unavailable"
	);
	const blockedDeploy = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/deploy`
	);
	expect(blockedDeploy.status).toBe(422);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.deploymentId
	).toBeNull();

	await setScannerMode(page, "pass");
	await companion
		.getByRole("button", { name: "Security", exact: true })
		.click();
	await expect(
		companion.getByText("Deployment blocked", { exact: true })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Run check again", exact: true })
		.click();
	await expect(
		companion.getByText(/potential secret was detected/)
	).toBeVisible();
	await companion.getByRole("button", { name: "Source", exact: true }).click();
	const cleanHtml =
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Clean test</title></head><body><h1>Clean build</h1></body></html>';
	await companion.getByLabel("HTML source", { exact: true }).fill(cleanHtml);
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Security", exact: true })
		.click();
	await expect(
		companion.getByText("Secret check passed", { exact: true })
	).toBeVisible();
	await companion
		.getByRole("button", { name: "Versions", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Deploy version", exact: true })
		.first()
		.click();
	const cleanDeploy = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/deploy`,
		1
	);
	expect(cleanDeploy.status).toBe(200);
	const afterDeploy = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(afterDeploy?.deploymentId).toBe(afterDeploy?.versions.at(-1)?.id);
});

test("capability settings stay disabled when identity, retrieval, answers, agent, or edge services are absent", async ({
	page,
}) => {
	const companion = await mountFreshSites(page, {
		agentAvailable: false,
		answersAvailable: false,
		edgeAvailable: false,
		identityAvailable: false,
		publicEnabled: false,
		retrievalAvailable: false,
		scannerAvailable: false,
	});
	const site = await createSite(companion, page, {
		name: "Reset permissions proof",
		slug: "reset-permissions-proof",
		template: "reset-calendar",
	});
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await expect(
		companion.getByText("Public publishing is disabled by the operator.")
	).toBeVisible();
	await companion.getByRole("combobox", { name: "Who can visit" }).click();
	await expect(
		companion.getByRole("option", { name: "Invited viewers" })
	).toBeDisabled();
	await expect(
		companion.getByRole("option", { name: "Workspace", exact: true })
	).toBeDisabled();
	await expect(
		companion.getByRole("option", { name: "Anyone on the internet" })
	).toBeDisabled();
	await page.keyboard.press("Escape");
	await expect(
		companion.getByRole("switch", { name: "Optional visitor sign-in" })
	).toBeDisabled();
	await expect(
		companion.getByRole("switch", { name: "Answers from connected knowledge" })
	).toBeDisabled();
	await expect(
		companion.getByRole("switch", { name: "Owner reset checks" })
	).toBeDisabled();
	await expect(
		companion.getByPlaceholder("Retrieval service not connected")
	).toBeDisabled();
	await expect(fieldControl(companion, "Workspace ID")).toHaveCount(0);
	await expect(
		fieldControl(companion, "Viewer emails (one per line)", "textarea")
	).toHaveCount(0);
	await expect(
		fieldControl(companion, "Editor emails (same workspace)", "textarea")
	).toHaveCount(0);
	await expect(fieldControl(companion, "Daily answer limit")).toHaveCount(0);
	await companion
		.getByPlaceholder("help.example.com")
		.fill("docs.example.test");
	await expect(
		companion.getByRole("button", { name: "Add domain", exact: true })
	).toBeDisabled();
	await expect(
		companion.getByText(
			"No edge or TLS provider is configured on this node, so custom domains stay pending TLS and do not serve traffic."
		)
	).toBeVisible();
	await capture(
		companion,
		"sites-companion-capability-permissions-disabled.png"
	);
	const projects = (await state(page)).projects;
	expect(
		projects.find((candidate) => candidate.id === site.id)?.settings
	).toMatchObject({
		audience: "private",
		agentActions: false,
		ai: false,
		optionalSignIn: false,
		spaceId: null,
	});
});

test("sharing, connected runtime, approved Space binding, local capabilities, and reset checks persist with exact normalized writes", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const site = await createSite(companion, page, {
		name: "Connected help proof",
		slug: "connected-help-proof",
	});
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await companion.getByRole("combobox", { name: "Who can visit" }).click();
	await companion
		.getByRole("option", { name: "Invited viewers", exact: true })
		.click();
	await fieldControl(
		companion,
		"Viewer emails (one per line)",
		"textarea"
	).fill("Reader@Example.Test");
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	const invitedSettingsCall = await waitForCall(
		page,
		"PUT",
		`/projects/${site.id}/settings`,
		0
	);
	expect(invitedSettingsCall.body).toMatchObject({
		expectedRevision: 0,
		settings: {
			audience: "invited",
			viewers: ["Reader@Example.Test"],
		},
	});
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.settings
	).toMatchObject({ audience: "invited", viewers: ["reader@example.test"] });

	await companion.getByRole("combobox", { name: "Who can visit" }).click();
	await companion
		.getByRole("option", { name: "Workspace", exact: true })
		.click();
	await fieldControl(companion, "Workspace ID").fill("workspace-not-member");
	await fieldControl(
		companion,
		"Viewer emails (one per line)",
		"textarea"
	).fill("Reader@Example.Test");
	await fieldControl(
		companion,
		"Editor emails (same workspace)",
		"textarea"
	).fill("Editor@Example.Test");
	await companion.getByRole("combobox", { name: "Data runtime" }).click();
	await companion
		.getByRole("option", { name: "Connected to Ryu", exact: true })
		.click();
	// Durable records need a bound Ryu Spaces database, which this proof host
	// cannot connect (see the database refusal case), so the switch stays off.
	await expect(
		companion.getByRole("switch", { name: "Durable records" })
	).toBeDisabled();
	await companion.getByRole("switch", { name: "File uploads" }).click();
	await companion
		.getByRole("switch", { name: "Optional visitor sign-in" })
		.click();
	await companion
		.getByRole("switch", { name: "Answers from connected knowledge" })
		.click();
	await fieldControl(companion, "Daily answer limit").fill("28");
	await companion
		.getByPlaceholder("Approved Space ID")
		.fill("space-not-approved");
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await expect(companion.getByRole("alert")).toContainText(
		"Choose a workspace you belong to"
	);
	const workspaceDenied = await waitForCall(
		page,
		"PUT",
		`/projects/${site.id}/settings`,
		1
	);
	expect(workspaceDenied.status).toBe(403);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.revision
	).toBe(1);
	await fieldControl(companion, "Workspace ID").fill("workspace-sites-proof");
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await expect(companion.getByRole("alert")).toContainText(
		"Space retrieval is not connected"
	);
	const deniedSettings = await waitForCall(
		page,
		"PUT",
		`/projects/${site.id}/settings`,
		2
	);
	expect(deniedSettings.status).toBe(503);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.revision
	).toBe(1);

	await companion
		.getByPlaceholder("Approved Space ID")
		.fill("space-approved-proof");
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	const savedSettingsCall = await waitForCall(
		page,
		"PUT",
		`/projects/${site.id}/settings`,
		3
	);
	expect(savedSettingsCall.status).toBe(200);
	expect(savedSettingsCall.body).toMatchObject({
		expectedRevision: 1,
		settings: {
			audience: "workspace",
			mode: "connected",
			workspaceId: "workspace-sites-proof",
			viewers: ["Reader@Example.Test"],
			editors: ["Editor@Example.Test"],
			optionalSignIn: true,
			storage: false,
			uploads: true,
			ai: true,
			aiDailyLimit: 28,
			spaceId: "space-approved-proof",
		},
	});
	const persisted = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(persisted?.settings).toMatchObject({
		audience: "workspace",
		mode: "connected",
		workspaceId: "workspace-sites-proof",
		viewers: ["reader@example.test"],
		editors: ["editor@example.test"],
		optionalSignIn: true,
		storage: false,
		uploads: true,
		ai: true,
		aiDailyLimit: 28,
		spaceId: "space-approved-proof",
	});
	await expect(
		fieldControl(companion, "Viewer emails (one per line)", "textarea")
	).toHaveValue("reader@example.test");
	await capture(companion, "sites-companion-connected-settings-saved.png");

	await companion.getByRole("combobox", { name: "Who can visit" }).click();
	await companion
		.getByRole("option", { name: "Anyone on the internet" })
		.click();
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	const publicSettingsCall = await waitForCall(
		page,
		"PUT",
		`/projects/${site.id}/settings`,
		4
	);
	expect(publicSettingsCall.body).toMatchObject({
		expectedRevision: 2,
		settings: {
			audience: "public",
			mode: "connected",
			spaceId: "space-approved-proof",
		},
	});
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.settings.audience
	).toBe("public");
	await companion.getByRole("button", { name: "Preview", exact: true }).click();
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	const knowledgeSave = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/versions`,
		-1
	);
	expect(knowledgeSave.body).toMatchObject({ expectedRevision: 3 });
	const connectedVersion = (await state(page)).projects
		.find((candidate) => candidate.id === site.id)
		?.versions.at(-1);
	if (!connectedVersion) {
		throw new Error("The connected help-center version did not persist.");
	}
	await companion
		.getByRole("button", { name: "Versions", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Deploy version", exact: true })
		.click();
	const knowledgeDeploy = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/deploy`,
		-1
	);
	expect(knowledgeDeploy.body).toEqual({
		versionId: connectedVersion.id,
		expectedRevision: 4,
	});
	const sitesStatus = await page.request.get("/__proof/sites/status");
	const serviceStatus = await sitesStatus.json();
	const connectedVisitor = await page.context().newPage();
	await connectedVisitor.goto(
		`http://connected-help-proof.localhost:${serviceStatus.visitorPort}/`
	);
	await connectedVisitor
		.getByLabel("Search articles")
		.fill("approved invoice retention");
	await expect(
		connectedVisitor.getByText(
			"Approved Space result for approved invoice retention.",
			{ exact: true }
		)
	).toBeVisible();
	const retrieveCall = (await state(page)).observations.retrievalCalls.at(-1);
	expect(retrieveCall).toEqual({
		query: "approved invoice retention",
		siteId: site.id,
		spaceId: "space-approved-proof",
	});
	const askButton = connectedVisitor.getByRole("button", {
		name: "Ask a question",
		exact: true,
	});
	await expect(askButton).toBeVisible();
	await askButton.click();
	await expect(
		connectedVisitor.getByText(
			"Fixture answer grounded in the approved Space for approved invoice retention.",
			{ exact: true }
		)
	).toBeVisible();
	const answerCall = (await state(page)).observations.answerCalls.at(-1);
	expect(answerCall).toEqual({
		query: "approved invoice retention",
		siteId: site.id,
		spaceId: "space-approved-proof",
	});
	await connectedVisitor.close();

	await companion
		.getByRole("button", { name: "All sites", exact: true })
		.click();
	const resetSite = await createSite(companion, page, {
		name: "Agent reset proof",
		slug: "agent-reset-proof",
		template: "reset-calendar",
	});
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	const resetToggle = companion.getByRole("switch", {
		name: "Owner reset checks",
	});
	await expect(resetToggle).toBeEnabled();
	await resetToggle.click();
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	const resetSettingsCall = await waitForCall(
		page,
		"PUT",
		`/projects/${resetSite.id}/settings`
	);
	expect(resetSettingsCall.body).toMatchObject({
		expectedRevision: 0,
		settings: { agentActions: true },
	});
	expect(
		(await state(page)).projects.find(
			(candidate) => candidate.id === resetSite.id
		)?.settings.agentActions
	).toBe(true);
});

test("URL changes preserve aliases; custom-domain add/remove is local and DNS checks stay external", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const site = await createSite(companion, page, {
		name: "URL and domain proof",
		slug: "address-proof",
		template: "website",
	});
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await fieldControl(companion, "Site URL name").fill("address-renamed-proof");
	await companion
		.getByRole("button", { name: "Change URL", exact: true })
		.click();
	const rename = await waitForCall(page, "PUT", `/projects/${site.id}/url`);
	expect(rename.body).toEqual({
		slug: "address-renamed-proof",
		expectedRevision: 0,
	});
	let current = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(current).toMatchObject({
		slug: "address-renamed-proof",
		aliases: ["address-proof"],
	});

	const domain = "docs.example.test";
	await companion.getByPlaceholder("help.example.com").fill(domain);
	await companion
		.getByRole("button", { name: "Add domain", exact: true })
		.click();
	const addDomain = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/domains`
	);
	expect(addDomain.body).toEqual({ host: domain, expectedRevision: 1 });
	current = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	expect(current?.domains).toHaveLength(1);
	expect(current?.domains[0]).toMatchObject({
		host: domain,
		status: "pending_dns",
	});
	await expect(
		companion.getByText(`TXT _ryu-sites.${domain} =`, { exact: false })
	).toBeVisible();
	await expect(
		companion.getByRole("button", { name: "Check DNS and TLS", exact: true })
	).toBeVisible();
	await capture(companion, "sites-companion-domain-pending-dns.png");
	await companion.getByRole("button", { name: "Remove", exact: true }).click();
	const removeDomain = await waitForCall(
		page,
		"DELETE",
		`/projects/${site.id}/domains`
	);
	expect(removeDomain.body).toEqual({ host: domain, expectedRevision: 2 });
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.domains
	).toHaveLength(0);
});

test("public visitor search persists browser-local articles, updates analytics, takes the site offline, and requires exact delete confirmation", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const hostUrl = page.url();
	const site = await createSite(companion, page, {
		name: "Visitor help proof",
		slug: "visitor-help-proof",
		prompt: "Answers for customers.",
	});
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await companion.getByRole("combobox", { name: "Who can visit" }).click();
	await companion
		.getByRole("option", { name: "Anyone on the internet" })
		.click();
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await waitForCall(page, "PUT", `/projects/${site.id}/settings`);
	await companion.getByRole("button", { name: "Preview", exact: true }).click();
	await companion
		.getByRole("button", { name: "Save version", exact: true })
		.click();
	const save = await waitForCall(page, "POST", `/projects/${site.id}/versions`);
	expect(save.status).toBe(201);
	const withVersion = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	const version = withVersion?.versions.at(-1);
	if (!version) {
		throw new Error("The help-center starter was not saved as a version.");
	}
	await companion
		.getByRole("button", { name: "Versions", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Deploy version", exact: true })
		.click();
	const deploy = await waitForCall(page, "POST", `/projects/${site.id}/deploy`);
	expect(deploy.body).toEqual({ versionId: version.id, expectedRevision: 2 });
	const visitorLink = companion
		.getByRole("link")
		.filter({ hasText: "visitor-help-proof.localhost" });
	const statusResponse = await page.request.get("/__proof/sites/status");
	expect(statusResponse.status()).toBe(200);
	const status = await statusResponse.json();
	const visitorUrl = `http://visitor-help-proof.localhost:${status.visitorPort}/`;
	const exactVisitorUrl = await visitorLink.getAttribute("href");
	expect(exactVisitorUrl).toBe(visitorUrl);
	await visitorLink.click();
	await expect
		.poll(() => page.evaluate(() => window.__sitesProof.openedExternal()))
		.toEqual([exactVisitorUrl]);
	expect(page.context().pages()).toHaveLength(1);
	await expect(page).toHaveURL(hostUrl);

	const visitor = await page.context().newPage();
	await visitor.goto(exactVisitorUrl ?? "");
	await expect(
		visitor.getByRole("heading", { name: "Visitor help proof" })
	).toBeVisible();
	await expect(visitor.getByRole("status")).toContainText("1 articles ready");
	await visitor.getByLabel("Import knowledge (.txt or .md)").setInputFiles({
		name: "refund-policy.md",
		mimeType: "text/markdown",
		buffer: Buffer.from(
			"Refund policy: customers may request a refund within 30 days."
		),
	});
	await expect(visitor.getByRole("status")).toContainText("2 articles ready");
	await visitor.getByLabel("Search articles").fill("refund within 30 days");
	await expect(
		visitor.getByRole("heading", { name: "refund-policy.md" })
	).toBeVisible();
	await expect(
		visitor.getByText("customers may request a refund within 30 days.")
	).toBeVisible();
	await visitor.reload();
	await visitor.getByLabel("Search articles").fill("refund within 30 days");
	await expect(
		visitor.getByRole("heading", { name: "refund-policy.md" })
	).toBeVisible();
	await capture(companion, "sites-companion-public-deployment-version.png");
	await mkdir(evidenceDirectory, { recursive: true });
	await visitor.screenshot({
		path: path.join(
			evidenceDirectory,
			"sites-companion-public-help-center.png"
		),
		fullPage: true,
	});

	await companion
		.getByRole("button", { name: "Analytics", exact: true })
		.click();
	await waitForCall(page, "GET", `/projects/${site.id}/analytics?days=7`);
	await expect(
		companion.getByRole("cell", { name: "2", exact: true })
	).toBeVisible();
	await companion
		.getByRole("combobox", { name: "Analytics date range" })
		.click();
	await companion
		.getByRole("option", { name: "Last 30 days", exact: true })
		.click();
	await waitForCall(page, "GET", `/projects/${site.id}/analytics?days=30`);
	await companion
		.getByRole("combobox", { name: "Analytics date range" })
		.click();
	await companion
		.getByRole("option", { name: "Last 90 days", exact: true })
		.click();
	await waitForCall(page, "GET", `/projects/${site.id}/analytics?days=90`);

	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await companion
		.getByRole("button", { name: "Take site offline", exact: true })
		.click();
	const offline = await waitForCall(
		page,
		"POST",
		`/projects/${site.id}/unpublish`
	);
	expect(offline.body).toMatchObject({ expectedRevision: 3 });
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.deploymentId
	).toBeNull();
	// Chromium resolves every *.localhost host to loopback itself; Node's
	// resolver (behind page.request) only does so when the OS resolver does.
	const offlineResponse = await visitor.goto(exactVisitorUrl ?? "");
	expect(offlineResponse?.status()).toBe(404);
	expect(await offlineResponse?.json()).toMatchObject({
		error: { message: "Site is not deployed" },
	});

	await companion
		.getByRole("button", { name: "Delete site", exact: true })
		.click();
	const deleteDialog = companion.getByRole("dialog");
	const permanentlyDelete = deleteDialog.getByRole("button", {
		name: "Permanently delete",
		exact: true,
	});
	await expect(permanentlyDelete).toBeDisabled();
	await deleteDialog.getByLabel("Confirm site URL name").fill("wrong-slug");
	await expect(permanentlyDelete).toBeDisabled();
	await deleteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(deleteDialog).toBeHidden();
	expect(
		(await calls(page)).filter(
			(call) => call.method === "DELETE" && call.path === `/projects/${site.id}`
		)
	).toHaveLength(0);
	await companion
		.getByRole("button", { name: "Delete site", exact: true })
		.click();
	await companion.getByLabel("Confirm site URL name").fill(site.slug);
	await expect(
		companion.getByRole("button", { name: "Permanently delete", exact: true })
	).toBeEnabled();
	await companion
		.getByRole("button", { name: "Permanently delete", exact: true })
		.click();
	const deleteCall = await waitForCall(page, "DELETE", `/projects/${site.id}`);
	expect(deleteCall.body).toEqual({ slug: site.slug, expectedRevision: 4 });
	expect((await state(page)).projects).toHaveLength(0);
	await expect(
		companion.getByRole("heading", { name: "No sites here" })
	).toBeVisible();
});

test("sharing validates recipients, transfers their role without duplicate access, and retries refused removal against the confirmed revision", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const site = await createSite(companion, page, {
		name: "Access role proof",
		slug: "access-role-proof",
	});
	const settingsPath = `/projects/${site.id}/settings`;
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	await companion.getByRole("combobox", { name: "Who can visit" }).click();
	await companion
		.getByRole("option", { name: "Workspace", exact: true })
		.click();
	await fieldControl(companion, "Workspace ID").fill("workspace-sites-proof");
	await companion
		.getByRole("button", { name: "Save settings", exact: true })
		.click();
	await waitForCall(page, "PUT", settingsPath);
	const workspaceSite = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	if (!workspaceSite) {
		throw new Error("Workspace access did not persist.");
	}
	await companion.getByRole("button", { name: "Share", exact: true }).click();
	const dialog = companion.getByRole("dialog", {
		name: "Share Access role proof",
		exact: true,
	});
	const addPerson = dialog.getByRole("button", {
		name: "Add person",
		exact: true,
	});
	await dialog.getByPlaceholder("name@example.com").fill("not-an-email");
	await expect(addPerson).toBeDisabled();
	expect(
		(await calls(page)).filter(
			(call) => call.method === "PUT" && call.path === settingsPath
		)
	).toHaveLength(1);
	await dialog
		.getByPlaceholder("name@example.com")
		.fill("  Reader@Example.Test  ");
	let releaseWrite!: () => void;
	const pendingWrite = new Promise<void>((resolve) => {
		releaseWrite = resolve;
	});
	const heldEndpoint = `**/__proof/sites${settingsPath}`;
	await page.route(
		heldEndpoint,
		async (route) => {
			await pendingWrite;
			await route.continue();
		},
		{ times: 1 }
	);
	try {
		await addPerson.click();
		await expect
			.poll(
				async () =>
					(await calls(page)).filter(
						(call) => call.method === "PUT" && call.path === settingsPath
					).length
			)
			.toBe(2);
		await expect(addPerson).toBeDisabled();
		await expect(
			dialog.getByRole("combobox", { name: "Who can visit" })
		).toBeDisabled();
		await addPerson.click({ force: true });
		expect(
			(await calls(page)).filter(
				(call) => call.method === "PUT" && call.path === settingsPath
			)
		).toHaveLength(2);
		expect(
			(await state(page)).projects.find((candidate) => candidate.id === site.id)
		).toEqual(workspaceSite);
	} finally {
		releaseWrite();
	}
	const addViewer = await waitForCall(page, "PUT", settingsPath, 1);
	expect(addViewer.body).toEqual({
		expectedRevision: workspaceSite.revision,
		settings: { ...workspaceSite.settings, viewers: ["reader@example.test"] },
	});
	await expect(
		dialog.getByRole("button", {
			name: "Remove reader@example.test",
			exact: true,
		})
	).toBeEnabled();
	const viewerSite = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	if (!viewerSite) {
		throw new Error("Viewer access did not persist.");
	}
	expect(viewerSite.settings).toEqual({
		...workspaceSite.settings,
		viewers: ["reader@example.test"],
	});
	await dialog.getByPlaceholder("name@example.com").fill("Reader@Example.Test");
	await dialog
		.getByRole("combobox", { name: "Access role", exact: true })
		.click();
	await companion.getByRole("option", { name: "Editor", exact: true }).click();
	await addPerson.click();
	const promote = await waitForCall(page, "PUT", settingsPath, 2);
	expect(promote.body).toEqual({
		expectedRevision: viewerSite.revision,
		settings: {
			...viewerSite.settings,
			viewers: [],
			editors: ["reader@example.test"],
		},
	});
	const editorSite = (await state(page)).projects.find(
		(candidate) => candidate.id === site.id
	);
	if (!editorSite) {
		throw new Error("Editor access did not persist.");
	}
	expect(editorSite.settings).toEqual({
		...viewerSite.settings,
		viewers: [],
		editors: ["reader@example.test"],
	});
	await expect(
		dialog.getByText("reader@example.test", { exact: true })
	).toHaveCount(1);
	await expect(
		dialog
			.getByText("reader@example.test", { exact: true })
			.locator("../..")
			.getByText("Editor", { exact: true })
	).toBeVisible();
	await page.evaluate(
		(pathName) =>
			window.__sitesProof.failNext(
				"PUT",
				pathName,
				"Removing access was refused."
			),
		settingsPath
	);
	await dialog
		.getByRole("button", { name: "Remove reader@example.test", exact: true })
		.click();
	const refused = await waitForCall(page, "PUT", settingsPath, 3);
	expect(refused.status).toBe(503);
	expect(refused.body).toEqual({
		expectedRevision: editorSite.revision,
		settings: { ...editorSite.settings, editors: [] },
	});
	await expect(dialog.getByRole("alert")).toContainText(
		"Removing access was refused."
	);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
	).toEqual(editorSite);
	await expect(
		dialog.getByRole("button", {
			name: "Remove reader@example.test",
			exact: true,
		})
	).toBeEnabled();
	await dialog
		.getByRole("button", { name: "Remove reader@example.test", exact: true })
		.click();
	const removed = await waitForCall(page, "PUT", settingsPath, 4);
	expect(removed.status).toBe(200);
	expect(removed.body).toEqual(refused.body);
	await expect(
		dialog.getByText("reader@example.test", { exact: true })
	).toHaveCount(0);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
	).toMatchObject({
		revision: editorSite.revision + 1,
		settings: { viewers: [], editors: [] },
	});
	await page.reload();
	const reopened = await mountSites(page);
	await reopened
		.getByRole("button", { name: "Open site", exact: true })
		.click();
	await reopened.getByRole("button", { name: "Share", exact: true }).click();
	await expect(
		reopened
			.getByRole("dialog")
			.getByText("reader@example.test", { exact: true })
	).toHaveCount(0);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
			?.settings.workspaceId
	).toBe("workspace-sites-proof");
});

test("site name refuses empty writes, retains a refused draft, retries the exact revision, and survives reloading the compiled Companion", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const site = await createSite(companion, page, {
		name: "Original name",
		slug: "name-retry-proof",
	});
	await companion
		.getByRole("button", { name: "Settings", exact: true })
		.click();
	const name = companion.getByLabel("Site name", { exact: true });
	const save = companion.getByRole("button", {
		name: "Save name",
		exact: true,
	});
	await name.fill("   ");
	await expect(save).toBeDisabled();
	const namePath = `/projects/${site.id}/name`;
	expect(
		(await calls(page)).filter((call) => call.path === namePath)
	).toHaveLength(0);
	await name.fill("Renamed durable guide");
	await page.evaluate(
		(pathName) =>
			window.__sitesProof.failNext("PUT", pathName, "Renaming was refused."),
		namePath
	);
	await save.click();
	const refused = await waitForCall(page, "PUT", namePath, 0);
	expect(refused.status).toBe(503);
	expect(refused.body).toEqual({
		name: "Renamed durable guide",
		expectedRevision: site.revision,
	});
	await expect(companion.getByRole("alert")).toContainText(
		"Renaming was refused."
	);
	await expect(name).toHaveValue("Renamed durable guide");
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
	).toEqual(site);
	await save.click();
	const accepted = await waitForCall(page, "PUT", namePath, 1);
	expect(accepted.status).toBe(200);
	expect(accepted.body).toEqual(refused.body);
	await expect(
		companion.getByRole("heading", {
			name: "Renamed durable guide",
			exact: true,
		})
	).toBeVisible();
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
	).toMatchObject({
		name: "Renamed durable guide",
		slug: site.slug,
		revision: site.revision + 1,
	});
	await page.reload();
	const reopened = await mountSites(page);
	await reopened
		.getByRole("button", { name: "Open site", exact: true })
		.click();
	await reopened.getByRole("button", { name: "Settings", exact: true }).click();
	await expect(reopened.getByLabel("Site name", { exact: true })).toHaveValue(
		"Renamed durable guide"
	);
	await expect(
		reopened.getByRole("button", { name: "Save name", exact: true })
	).toBeDisabled();
	expect(
		(await calls(page)).filter((call) => call.path === namePath)
	).toHaveLength(0);
});

test("database read refusal retries only the selected Site read and keeps unavailable connection and SQL writes blocked", async ({
	page,
}) => {
	const companion = await mountFreshSites(page);
	const site = await createSite(companion, page, {
		name: "Database refusal proof",
		slug: "database-refusal-proof",
	});
	const databasePath = `/projects/${site.id}/database`;
	await page.evaluate(
		(pathName) =>
			window.__sitesProof.failNext(
				"GET",
				pathName,
				"Database connection status was refused."
			),
		databasePath
	);
	await companion
		.getByRole("button", { name: "Database", exact: true })
		.click();
	const refused = await waitForCall(page, "GET", databasePath, 0);
	expect(refused.status).toBe(503);
	expect(refused.body).toBeUndefined();
	await expect(companion.getByRole("alert")).toContainText(
		"Database connection status was refused."
	);
	await expect(
		companion.getByRole("button", {
			name: "Connect Ryu Spaces database",
			exact: true,
		})
	).toBeDisabled();
	await companion.getByRole("button", { name: "Refresh", exact: true }).click();
	const recovered = await waitForCall(page, "GET", databasePath, 1);
	expect(recovered.status).toBe(200);
	expect(recovered.body).toBeUndefined();
	expect(recovered.result).toMatchObject({ connected: false });
	await expect(
		companion.getByText("Database connection status was refused.", {
			exact: true,
		})
	).toHaveCount(0);
	await expect(
		companion.getByRole("button", {
			name: "Connect Ryu Spaces database",
			exact: true,
		})
	).toBeDisabled();
	await expect(companion.getByLabel("SQL query", { exact: true })).toHaveCount(
		0
	);
	expect(
		(await calls(page)).filter((call) => call.path.startsWith(databasePath))
	).toEqual([refused, recovered]);
	expect(
		(await state(page)).projects.find((candidate) => candidate.id === site.id)
	).toEqual(site);
});
