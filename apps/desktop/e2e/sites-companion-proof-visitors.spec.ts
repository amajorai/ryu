import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	calls,
	capture,
	createSite,
	evidenceDirectory,
	fieldControl,
	mountFreshSites,
	mountSites,
	state,
	waitForCall,
} from "./harness/sites-companion-proof.helpers.ts";

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
