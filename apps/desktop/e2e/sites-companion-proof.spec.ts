import { expect, test } from "@playwright/test";
import {
	calls,
	capture,
	createSite,
	mountFreshSites,
	mountSites,
	openHost,
	resetProof,
	state,
	waitForCall,
} from "./harness/sites-companion-proof.helpers.ts";

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
