import { mkdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
	type AgentModelsSnapshot,
	agentModelsSnapshotSchema,
} from "./agent-models-proof.contracts.ts";

// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
// the tracked proof ledger; without it the committed evidence is refreshed.
const evidenceDir =
	process.env.RYU_PROOF_EVIDENCE_DIR ??
	path.resolve(
		import.meta.dirname,
		"../../../docs/proof/test-coverage-sweep-20260924/evidence"
	);

mkdirSync(evidenceDir, { recursive: true });

async function readState(
	page: import("@playwright/test").Page
): Promise<AgentModelsSnapshot> {
	return agentModelsSnapshotSchema.parse(
		await page.evaluate(() => {
			const proof = window.__agentModelsSettingsProof;
			if (!proof) {
				throw new Error("Agent models fixture is not installed");
			}
			return proof.snapshot();
		})
	);
}

async function armFailure(
	page: import("@playwright/test").Page,
	operation: string
): Promise<void> {
	await page.evaluate((value) => {
		const proof = window.__agentModelsSettingsProof;
		if (!proof) {
			throw new Error("Agent models fixture is not installed");
		}
		proof.armFailure(value);
	}, operation);
}

async function openAgent(
	page: import("@playwright/test").Page,
	name: string
): Promise<void> {
	await page.getByRole("button", { name: new RegExp(name) }).click();
}

function modelSwitch(page: import("@playwright/test").Page, name: string) {
	return page.getByRole("switch", {
		name: `Show ${name} in Codex's model picker`,
	});
}

test.describe.configure({ timeout: 60_000 });

test("keeps agent probing lazy and renders each advertised model source", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await page.goto("/agent-models-settings-proof.html?reset=true");
	await expect(page.getByText("Codex", { exact: true })).toBeVisible();
	await expect(page.getByText("Ryu", { exact: true })).toHaveCount(0);
	let snapshot = await readState(page);
	expect(snapshot.requests).toEqual([
		{ body: null, method: "GET", path: "/api/agents" },
	]);

	await openAgent(page, "Codex");
	await expect(page.getByText("Codex Pro", { exact: true })).toBeVisible();
	await openAgent(page, "OpenCode");
	await expect(
		page.getByText("OpenCode Balanced", { exact: true })
	).toBeVisible();
	await openAgent(page, "Self Selecting Agent");
	await expect(
		page.getByText(/This agent advertises no model list of its own/u)
	).toBeVisible();

	snapshot = await readState(page);
	expect(
		snapshot.requests
			.filter((request) => request.path.includes("/acp-config"))
			.map((request) => request.path)
	).toEqual([
		"/api/agents/codex/acp-config",
		"/api/agents/opencode/acp-config",
		"/api/agents/self-selecting/acp-config",
	]);
	await expect(
		page.getByRole("switch", {
			name: "Show Codex Pro in Codex's model picker",
		})
	).toBeVisible();
	await expect(page.getByRole("switch")).toHaveCount(4);
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "desktop-agent-models-advertised-sources.png"),
	});
	expect(pageErrors).toEqual([]);
});

test("writes the exact agent scope, rolls back a denied toggle, and persists after reload", async ({
	page,
}) => {
	await page.goto("/agent-models-settings-proof.html?reset=true");
	await openAgent(page, "Codex");
	const codexPro = modelSwitch(page, "Codex Pro");
	await expect(codexPro).toBeChecked();
	const visibleBackground = await codexPro.evaluate(
		(element) => getComputedStyle(element).backgroundColor
	);
	const visibleThumbTranslate = await codexPro.evaluate(
		(element) => getComputedStyle(element.firstElementChild!).translate
	);

	await armFailure(page, "permission");
	await codexPro.click();
	await expect(page.getByText("Could not update model")).toBeVisible();
	await expect(codexPro).toBeChecked();
	await expect(
		page.getByRole("button", { name: /Codex.*All models visible/u })
	).toBeVisible();

	await codexPro.click();
	await expect(codexPro).not.toBeChecked();
	await expect(codexPro).toHaveAttribute("data-unchecked");
	await expect
		.poll(() =>
			codexPro.evaluate((element) => getComputedStyle(element).backgroundColor)
		)
		.not.toBe(visibleBackground);
	await expect
		.poll(() =>
			codexPro.evaluate(
				(element) => getComputedStyle(element.firstElementChild!).translate
			)
		)
		.not.toBe(visibleThumbTranslate);
	await expect(
		page.getByRole("button", { name: /Codex.*1 model hidden/u })
	).toBeVisible();
	let snapshot = await readState(page);
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/api/pi-config/providers/model-enabled")
		)
	).toEqual([
		{
			body: { enabled: false, model: "codex-pro", provider: "agent:codex" },
			method: "POST",
			path: "/api/pi-config/providers/model-enabled",
		},
		{
			body: { enabled: false, model: "codex-pro", provider: "agent:codex" },
			method: "POST",
			path: "/api/pi-config/providers/model-enabled",
		},
	]);
	expect(snapshot.agentModelOverrides).toEqual({
		codex: { "codex-pro": false },
	});
	await page.reload();
	await openAgent(page, "Codex");
	await expect(modelSwitch(page, "Codex Pro")).not.toBeChecked();
	await expect(
		page.getByRole("button", { name: /Codex.*1 model hidden/u })
	).toBeVisible();
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "desktop-agent-models-hidden-persisted.png"),
	});
	await armFailure(page, "hold-write");
	await modelSwitch(page, "Codex Pro").click();
	await expect(modelSwitch(page, "Codex Pro")).toBeDisabled();
	await page.evaluate(() => {
		const proof = window.__agentModelsSettingsProof;
		if (!proof) {
			throw new Error("Agent models fixture is not installed");
		}
		proof.releasePendingWrite();
	});
	await expect(modelSwitch(page, "Codex Pro")).toBeChecked();
	await expect(modelSwitch(page, "Codex Pro")).toHaveAttribute("data-checked");
	await expect
		.poll(() =>
			modelSwitch(page, "Codex Pro").evaluate(
				(element) => getComputedStyle(element).backgroundColor
			)
		)
		.toBe(visibleBackground);
	snapshot = await readState(page);
	expect(snapshot.agentModelOverrides).toEqual({
		codex: { "codex-pro": true },
	});
	expect(
		snapshot.requests.filter((request) =>
			request.path.endsWith("/api/pi-config/providers/model-enabled")
		)
	).toEqual([
		{
			body: { enabled: true, model: "codex-pro", provider: "agent:codex" },
			method: "POST",
			path: "/api/pi-config/providers/model-enabled",
		},
	]);
});

test("shows the empty installation state", async ({ page }) => {
	await page.goto("/agent-models-settings-proof.html?reset=true&empty=true");
	await expect(
		page.getByText("No agents installed.", { exact: true })
	).toBeVisible();
	await expect(page.getByRole("button")).toHaveCount(0);
	const snapshot = await readState(page);
	expect(snapshot.requests).toEqual([
		{ body: null, method: "GET", path: "/api/agents" },
	]);
});

test("distinguishes an agent-list failure from an empty installation and retries the same read", async ({
	page,
}) => {
	await page.goto(
		"/agent-models-settings-proof.html?reset=true&failAgentsOnce=true"
	);
	await expect(page.getByRole("alert")).toContainText("Could not load agents:");
	await expect(
		page.getByText("No agents installed.", { exact: true })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "desktop-agent-models-load-error.png"),
	});
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByText("Codex", { exact: true })).toBeVisible();
	await expect(page.getByRole("alert")).toHaveCount(0);
	const snapshot = await readState(page);
	expect(snapshot.requests).toEqual([
		{ body: null, method: "GET", path: "/api/agents" },
		{ body: null, method: "GET", path: "/api/agents" },
	]);
	await page.screenshot({
		fullPage: true,
		path: path.join(evidenceDir, "desktop-agent-models-load-recovered.png"),
	});
});

test("keeps the last agent rows visible if a refresh fails, then retries without dropping them", async ({
	page,
}) => {
	await page.goto("/agent-models-settings-proof.html?reset=true");
	await expect(page.getByText("Codex", { exact: true })).toBeVisible();
	await armFailure(page, "agents");
	await page.evaluate(async () => {
		const proof = window.__agentModelsSettingsProof;
		if (!proof) {
			throw new Error("Agent models fixture is not installed");
		}
		await proof.refreshAgents();
	});
	await expect(page.getByRole("alert")).toContainText("Could not load agents:");
	await expect(page.getByText("Codex", { exact: true })).toBeVisible();
	await expect(
		page.getByText("No agents installed.", { exact: true })
	).toHaveCount(0);
	await page.screenshot({
		fullPage: true,
		path: path.join(
			evidenceDir,
			"desktop-agent-models-refresh-error-stale-list.png"
		),
	});
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect(page.getByText("Codex", { exact: true })).toBeVisible();
	const snapshot = await readState(page);
	expect(snapshot.requests).toEqual([
		{ body: null, method: "GET", path: "/api/agents" },
		{ body: null, method: "GET", path: "/api/agents" },
		{ body: null, method: "GET", path: "/api/agents" },
	]);
});

test("shows an ACP probe error and recovers when the user closes and retries the agent", async ({
	page,
}) => {
	await page.goto("/agent-models-settings-proof.html?reset=true");
	await armFailure(page, "codex-config");
	await openAgent(page, "Codex");
	await expect(
		page.getByText(/Could not read this agent's models/u)
	).toBeVisible();
	await openAgent(page, "Codex");
	await openAgent(page, "Codex");
	await expect(page.getByText("Codex Pro", { exact: true })).toBeVisible();
	const snapshot = await readState(page);
	expect(
		snapshot.requests.filter(
			(request) => request.path === "/api/agents/codex/acp-config"
		)
	).toHaveLength(2);
});
