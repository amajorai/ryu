import { expect, test } from "@playwright/test";
import {
	callsFor,
	guardBrowserIssues,
	openExportSection,
	openGateway,
	saveScreenshot,
} from "./agent-sync-proof.fixture.ts";

guardBrowserIssues();

test.describe.configure({ timeout: 90_000 });

test("Gateway caller shows sync loading, Core errors, and read retries", async ({
	page,
}) => {
	const fixture = await openGateway(page, {
		failures: [
			{
				error: "fixture workspace permission denied",
				method: "GET",
				path: "/api/workspace/list",
				status: 403,
				times: 1,
			},
			{
				error: "fixture profile store busy",
				method: "GET",
				path: "/api/agent-sync/profiles",
				status: 503,
				times: 1,
			},
		],
		holdInitialSyncReads: true,
	});

	await expect(
		page.getByRole("status").filter({ hasText: "Loading sync roots…" })
	).toBeVisible();
	await expect(page.getByText("No sync roots configured yet.")).toHaveCount(0);
	fixture.releaseInitialSyncReads();

	const profileError = page
		.getByRole("alert")
		.filter({ hasText: "/api/agent-sync/profiles failed: 503" });
	const homeError = page
		.getByRole("alert")
		.filter({ hasText: "fixture workspace permission denied" });
	await expect(profileError).toBeVisible();
	await expect(homeError).toBeVisible();
	await profileError.getByRole("button", { name: "Retry" }).click();
	await homeError.getByRole("button", { name: "Retry" }).click();
	await expect(
		page.getByRole("button", { name: "Use", exact: true })
	).toHaveCount(2);
	await expect(page.getByRole("button", { name: /^Claude/ })).toBeVisible();
	await expect(profileError).toHaveCount(0);
	await expect(homeError).toHaveCount(0);

	const profileReads = callsFor(fixture, "GET", "/api/agent-sync/profiles");
	const statusReads = callsFor(fixture, "GET", "/api/agent-sync/status");
	expect(profileReads).toHaveLength(2);
	expect(statusReads.length).toBeGreaterThanOrEqual(2);
	expect(profileReads[0].headers).toEqual({
		authorization: "Bearer fixture-node-token",
		"x-ryu-user-jwt": "fixture-user-jwt",
	});
	expect(callsFor(fixture, "GET", "/api/workspace/list")).toHaveLength(2);
});

test("Gateway Import uses the selected profile, maps all detected roots, and persists both switches", async ({
	page,
}) => {
	const fixture = await openGateway(page);
	await expect(page.getByText("detected", { exact: true })).toHaveCount(5);

	const rootInput = page.getByLabel("Root path");
	const provider = page.getByLabel("Agent provider");
	for (const entry of [
		{ label: "Claude", path: "/Users/fixture/.claude", provider: "claude" },
		{ label: "Codex", path: "/Users/fixture/.codex", provider: "codex" },
		{ label: "Cursor", path: "/Users/fixture/.cursor", provider: "cursor" },
		{
			label: "OpenClaw",
			path: "/Users/fixture/.openclaw",
			provider: "openclaw",
		},
		{ label: "Hermes", path: "/Users/fixture/.hermes", provider: "hermes" },
	]) {
		await page
			.getByRole("button", { name: new RegExp(`^${entry.label}`) })
			.click();
		await expect(rootInput).toHaveValue(entry.path);
		await expect(provider).toHaveValue(entry.provider);
		const scans = callsFor(fixture, "POST", "/api/agent-sync/scan").filter(
			(call) =>
				JSON.stringify(call.body) ===
				JSON.stringify({ path: entry.path, provider: entry.provider })
		);
		expect(scans.length).toBeGreaterThanOrEqual(2);
		expect(scans.at(-1)?.body).toEqual({
			path: entry.path,
			provider: entry.provider,
		});
	}

	await page.getByRole("button", { name: /^OpenClaw/ }).click();
	await expect(page.getByText("Review before cutover")).toBeVisible();
	await expect(
		page.getByText(/Channels configured in OpenClaw \(telegram\)/)
	).toBeVisible();
	await page.getByLabel("Agent provider").selectOption("mastra");
	await expect(rootInput).toHaveAttribute(
		"placeholder",
		"/Users/you/code/mastra-app"
	);

	await page.getByRole("button", { name: "Use", exact: true }).nth(1).click();
	await expect(rootInput).toHaveValue("/Users/fixture/.codex");
	await expect(provider).toHaveValue("codex");
	await expect(
		page.getByText("Codex · selected", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Import preview" })
	).toHaveCount(0);

	const codexImport = page.getByRole("switch", {
		name: "Enable import for Codex",
	});
	const codexExport = page.getByRole("switch", {
		name: "Enable export for Codex",
	});
	await expect(codexImport).toBeChecked();
	await codexImport.click();
	await expect(codexImport).not.toBeChecked();
	await codexExport.click();
	await expect(codexExport).toBeChecked();
	await page.getByRole("button", { name: "Save root + enable import" }).click();
	await expect(
		page.getByText("Profile profile-codex", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Scan", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Import preview" })
	).toBeVisible();
	// One whole-sentence caption since the i18n conversion (#915).
	await expect(
		page.getByText(/ · native threads readable · ACP /u)
	).toBeVisible();

	const saves = callsFor(fixture, "POST", "/api/agent-sync/profiles");
	expect(saves.map((call) => call.body)).toEqual([
		{
			exportEnabled: false,
			id: "profile-codex",
			importEnabled: false,
			provider: "codex",
			root: "/Users/fixture/.codex",
		},
		{
			exportEnabled: true,
			id: "profile-codex",
			importEnabled: false,
			provider: "codex",
			root: "/Users/fixture/.codex",
		},
		{
			exportEnabled: true,
			id: "profile-codex",
			importEnabled: true,
			provider: "codex",
			root: "/Users/fixture/.codex",
		},
	]);
	await saveScreenshot(page, "gateway-agent-sync-profile-saved.png");
});

test("Gateway Import previews selected setup and imports selected native threads with Core contracts", async ({
	page,
}) => {
	const fixture = await openGateway(page);
	const root = "/Users/fixture/manual-codex";
	await page.getByLabel("Root path").fill(root);
	await page.getByLabel("Agent provider").selectOption("codex");
	await page.getByRole("button", { name: "Scan", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Import preview" })
	).toBeVisible();
	await expect(page.getByText("Fixture skill", { exact: true })).toBeVisible();

	const checkboxes = page.getByRole("checkbox");
	await expect(checkboxes).toHaveCount(4);
	await expect(checkboxes.nth(0)).toBeChecked();
	await expect(checkboxes.nth(1)).toBeChecked();
	await checkboxes.nth(0).uncheck();
	await checkboxes.nth(1).uncheck();
	await expect(
		page.getByRole("button", { name: "Preview selected" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Import selected", exact: true })
	).toBeDisabled();
	await checkboxes.nth(1).check();
	await checkboxes.nth(2).uncheck();
	await page.getByRole("button", { name: "Import selected threads" }).click();
	await expect(
		page.getByText(
			"Native thread import complete: 7 messages added, 0 already linked."
		)
	).toBeVisible();

	await page.getByRole("button", { name: "Preview selected" }).click();
	await expect(
		page.getByText(/Preview import-preview-fixture-001/)
	).toBeVisible();
	await page
		.getByRole("button", { name: "Import selected", exact: true })
		.click();
	await expect(page.getByText(/Import import-fixture-001/)).toBeVisible();
	await expect(
		page.getByText("import-fixture-001", { exact: true })
	).toBeVisible();

	expect(
		callsFor(fixture, "POST", "/api/agent-sync/scan").at(-1)
	).toMatchObject({
		body: { path: root, provider: "codex" },
		method: "POST",
		path: "/api/agent-sync/scan",
	});
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/profiles").map(
			(call) => call.body
		)
	).toEqual([
		{
			exportEnabled: false,
			importEnabled: true,
			provider: "codex",
			root,
		},
	]);
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/threads/import").map(
			(call) => call.body
		)
	).toEqual([
		{ agentId: "agent-codex-fixture", dryRun: false, threadId: "thread-002" },
	]);
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/import").map((call) => call.body)
	).toEqual([
		{
			dryRun: true,
			items: [{ id: "skills/fixture-skill/SKILL.md", kind: "skill" }],
			path: root,
			profileId: "profile-created-codex",
		},
		{
			dryRun: false,
			items: [{ id: "skills/fixture-skill/SKILL.md", kind: "skill" }],
			path: root,
			profileId: "profile-created-codex",
		},
	]);
	for (const call of [
		...callsFor(fixture, "POST", "/api/agent-sync/profiles"),
		...callsFor(fixture, "POST", "/api/agent-sync/threads/import"),
		...callsFor(fixture, "POST", "/api/agent-sync/import"),
	]) {
		expect(call.headers).toEqual({
			authorization: "Bearer fixture-node-token",
			"x-ryu-user-jwt": "fixture-user-jwt",
		});
	}
	await page
		.getByRole("heading", { name: "Sync proof" })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "gateway-agent-sync-import-completed.png");
});

test("Gateway Export honors the selected root, bundle options, and ACP load or transcript replay", async ({
	page,
}) => {
	const fixture = await openGateway(page);
	await openExportSection(page);
	const destination = page.getByLabel("Destination folder");
	const useRoot = page.getByRole("button", { name: "Use selected root" });
	await expect(useRoot).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Preview bundle" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Export bundle" })
	).toBeDisabled();

	await page.getByRole("button", { name: "Use", exact: true }).nth(1).click();
	await expect(destination).toHaveValue("/Users/fixture/.codex");
	await expect(
		page.getByText("Codex · selected", { exact: true })
	).toBeVisible();
	await destination.fill("/Users/fixture/temporary-destination");
	await useRoot.click();
	await expect(destination).toHaveValue("/Users/fixture/.codex");

	await page.getByRole("checkbox", { name: "Agent definitions" }).uncheck();
	const conversationTranscripts = page.getByRole("checkbox", {
		name: "Conversation transcripts",
	});
	// Picking a destination restores its saved transcript choice, and the fixture
	// Codex profile has none (profileIncludesConversations, unchanged since 07d403e33).
	await expect(conversationTranscripts).not.toBeChecked();
	await conversationTranscripts.check();
	await conversationTranscripts.uncheck();
	await conversationTranscripts.check();
	await page.getByRole("checkbox", { name: "Agent Skills" }).uncheck();
	await page.getByRole("button", { name: "Preview bundle" }).click();
	await expect(
		page.getByText("export-preview-fixture-001", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Export bundle" }).click();
	await expect(
		page.getByText("bundle-hash-fixture-001", { exact: true })
	).toBeVisible();
	await expect(
		page.getByText("export-fixture-001", { exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Test ACP resume/load" }).click();
	await expect(
		page.getByText("1 ACP sessions loaded/resumed, 1 transcript replays.")
	).toBeVisible();
	await expect(
		page.getByText(/1 load\/resume · 1 replay fallback/)
	).toBeVisible();

	expect(
		callsFor(fixture, "POST", "/api/agent-sync/export").map((call) => call.body)
	).toEqual([
		{
			destination: "/Users/fixture/.codex",
			dryRun: true,
			includeAgents: false,
			includeConversations: true,
			includeSkills: false,
			profileId: "profile-codex",
		},
		{
			destination: "/Users/fixture/.codex",
			dryRun: false,
			includeAgents: false,
			includeConversations: true,
			includeSkills: false,
			profileId: "profile-codex",
		},
	]);
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/acp/resume").map(
			(call) => call.body
		)
	).toEqual([
		{ conversationId: "conversation-load" },
		{ conversationId: "conversation-replay" },
	]);
	await page
		.getByRole("heading", { name: "Sync proof" })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "gateway-agent-sync-export-acp-completed.png");
});

test("Gateway Export resolves each conflict with the selected Core contract", async ({
	page,
}) => {
	const fixture = await openGateway(page);
	await openExportSection(page);
	await expect(page.getByText("Conflict paused", { exact: true })).toHaveCount(
		2
	);
	await page.getByRole("button", { name: "Keep external" }).first().click();
	await expect(page.getByText("Conflict paused", { exact: true })).toHaveCount(
		1
	);
	await page.getByRole("button", { name: "Keep Ryu" }).click();
	await expect(page.getByText("Conflict paused", { exact: true })).toHaveCount(
		0
	);
	await expect(
		page.getByText("External changes are paused until reviewed.")
	).toHaveCount(0);

	expect(
		callsFor(fixture, "PUT", "/api/agent-sync/conflicts/resolve").map(
			(call) => call.body
		)
	).toEqual([
		{
			itemId: "skill-conflict",
			kind: "skill",
			profileId: "profile-claude",
			resolution: "keep_external",
		},
		{
			itemId: "agent-conflict",
			kind: "agent",
			profileId: "profile-codex",
			resolution: "keep_ryu",
		},
	]);
	await page
		.getByRole("heading", { name: "Conflicts" })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(page, "gateway-agent-sync-conflicts-resolved.png");
});

test("Core permission denials stay visible and each failed operation can be retried", async ({
	page,
}) => {
	const fixture = await openGateway(page, {
		failures: [
			{
				bodyPath: "/Users/fixture/permission-scan",
				error: "insufficient permissions: agent.view",
				method: "POST",
				path: "/api/agent-sync/scan",
				status: 403,
				times: 1,
			},
			{
				error: "insufficient permissions: agent.edit",
				method: "POST",
				path: "/api/agent-sync/profiles",
				status: 403,
				times: 1,
			},
			{
				error: "insufficient permissions: agent.edit",
				method: "POST",
				path: "/api/agent-sync/export",
				status: 403,
				times: 1,
			},
			{
				error: "insufficient permissions: agent.run",
				method: "POST",
				path: "/api/agent-sync/acp/resume",
				status: 403,
				times: 1,
			},
		],
	});
	const root = "/Users/fixture/permission-scan";
	await page.getByLabel("Root path").fill(root);
	await page.getByRole("button", { name: "Scan", exact: true }).click();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "/api/agent-sync/scan failed: 403" })
	).toBeVisible();
	await page.getByRole("button", { name: "Scan", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Import preview" })
	).toBeVisible();
	await page.getByRole("button", { name: "Save root + enable import" }).click();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "/api/agent-sync/profiles failed: 403" })
	).toBeVisible();
	await page.getByRole("button", { name: "Save root + enable import" }).click();
	await expect(
		page.getByText("Profile profile-created-claude", { exact: true })
	).toBeVisible();

	await openExportSection(page);
	const destination = page.getByLabel("Destination folder");
	await destination.fill("/Users/fixture/export-permission");
	await page.getByRole("button", { name: "Preview bundle" }).click();
	await expect(
		page.getByText("/api/agent-sync/export failed: 403")
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Sync proof" })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Preview bundle" }).click();
	await expect(
		page.getByText("export-preview-fixture-001", { exact: true })
	).toBeVisible();

	await page.getByRole("button", { name: "Test ACP resume/load" }).click();
	await expect(
		page.getByText("/api/agent-sync/acp/resume failed: 403")
	).toBeVisible();
	await page.getByRole("button", { name: "Test ACP resume/load" }).click();
	await expect(
		page.getByText("1 ACP sessions loaded/resumed, 1 transcript replays.")
	).toBeVisible();

	expect(
		callsFor(fixture, "POST", "/api/agent-sync/scan").filter(
			// SAFETY: callsFor selects only this fixture POST scan captures, produced by actual scanAgentSyncRoot { path, provider } serialization from the mounted root input.
			(call) => (call.body as { path?: string }).path === root
		)
	).toHaveLength(2);
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/profiles").map(
			(call) => call.body
		)
	).toEqual([
		{
			exportEnabled: false,
			importEnabled: true,
			provider: "claude",
			root,
		},
		{
			exportEnabled: false,
			importEnabled: true,
			provider: "claude",
			root,
		},
	]);
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/export").map((call) => call.body)
	).toEqual([
		{
			destination: "/Users/fixture/export-permission",
			dryRun: true,
			includeAgents: true,
			// Transcripts are opt-in: off until checked or restored from a profile.
			includeConversations: false,
			includeSkills: true,
		},
		{
			destination: "/Users/fixture/export-permission",
			dryRun: true,
			includeAgents: true,
			// Transcripts are opt-in: off until checked or restored from a profile.
			includeConversations: false,
			includeSkills: true,
		},
	]);
	expect(
		callsFor(fixture, "POST", "/api/agent-sync/acp/resume").map(
			(call) => call.body
		)
	).toEqual([
		{ conversationId: "conversation-load" },
		{ conversationId: "conversation-load" },
		{ conversationId: "conversation-replay" },
	]);
	await page
		.getByRole("heading", { name: "Sync proof" })
		.scrollIntoViewIfNeeded();
	await saveScreenshot(
		page,
		"gateway-agent-sync-permission-retry-completed.png"
	);
});

test("Import and Export actions stay disabled until their required local state exists", async ({
	page,
}) => {
	const fixture = await openGateway(page, {
		bindings: [],
		emptyScanPath: "/Users/fixture/empty-scan",
		noAgentScanPath: "/Users/fixture/no-agent",
	});
	const scanButton = page.getByRole("button", { name: "Scan", exact: true });
	const saveButton = page.getByRole("button", {
		name: "Save root + enable import",
	});
	await expect(scanButton).toBeDisabled();
	await expect(saveButton).toBeDisabled();

	await page.getByLabel("Root path").fill("/Users/fixture/empty-scan");
	await scanButton.click();
	await expect(page.getByText("No supported setup items found.")).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Preview selected" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Import selected", exact: true })
	).toBeDisabled();

	await page.getByLabel("Root path").fill("/Users/fixture/no-agent");
	await scanButton.click();
	await expect(
		page.getByText("Agent unavailable", { exact: true })
	).toBeVisible();
	const threadImport = page.getByRole("button", {
		name: "Import selected threads",
	});
	await expect(threadImport).toBeDisabled();
	const threadCheckbox = page.getByRole("checkbox").last();
	await threadCheckbox.uncheck();
	await expect(threadImport).toBeDisabled();

	await openExportSection(page);
	await expect(
		page.getByRole("button", { name: "Use selected root" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Preview bundle" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Export bundle" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Test ACP resume/load" })
	).toBeDisabled();
	expect(callsFor(fixture, "POST", "/api/agent-sync/threads/import")).toEqual(
		[]
	);
	expect(callsFor(fixture, "POST", "/api/agent-sync/import")).toEqual([]);
	expect(callsFor(fixture, "POST", "/api/agent-sync/export")).toEqual([]);
	expect(callsFor(fixture, "POST", "/api/agent-sync/acp/resume")).toEqual([]);
});
