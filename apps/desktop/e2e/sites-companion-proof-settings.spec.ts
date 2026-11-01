import { expect, test } from "@playwright/test";
import {
	capture,
	createSite,
	fieldControl,
	mountFreshSites,
	setScannerMode,
	state,
	waitForCall,
} from "./harness/sites-companion-proof.helpers.ts";

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
	// The grounded-answers switch became "AI for visitors" (with an AI mode
	// select) before 07d403e33; it stays disabled with no answers or model.
	await expect(
		companion.getByRole("switch", { name: "AI for visitors" })
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
	await companion.getByRole("switch", { name: "AI for visitors" }).click();
	await expect(
		companion.getByRole("combobox", { name: "AI mode" })
	).toContainText("Grounded answers");
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
