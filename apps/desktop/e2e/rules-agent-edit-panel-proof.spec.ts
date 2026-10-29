import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { z } from "zod";

const PAGE_URL = "/rules-agent-edit-panel-proof.html";
const AGENT_ID = "rules-panel-proof-agent";
const PREFERENCE_KEY = `rules.agent.${encodeURIComponent(AGENT_ID)}`;
const STORAGE_KEY = "ryu:e2e:rules-agent-edit-panel";
const EVIDENCE_DIR = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const RULES_HOOK_PATH = path.resolve(
	import.meta.dirname,
	"../../../plugins-store/plugins/rules/hooks/inject.js"
);

interface AgentRule {
	enabled: boolean;
	id: string;
	mode: "auto" | "always" | "manual";
	text: string;
}

interface AgentRulesConfig {
	applyMode: "auto" | "always" | "manual";
	autoInject: boolean;
	enabled: boolean;
	rules: AgentRule[];
	turnsPerPlan: number;
}

interface RecordedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface CoreSnapshot {
	preferences: Record<string, string>;
	requests: RecordedRequest[];
}

interface RulesAgentEditProof {
	armNextPreferenceWriteFailure: () => void;
	snapshot: () => CoreSnapshot;
}

declare global {
	interface Window {
		__rulesAgentEditPanelProof?: RulesAgentEditProof;
	}
}

const INITIAL_CONFIG: AgentRulesConfig = {
	applyMode: "auto",
	autoInject: true,
	enabled: true,
	rules: [
		{
			enabled: true,
			id: "existing-team-rule",
			mode: "auto",
			text: "Use the team's established conventions.",
		},
	],
	turnsPerPlan: 3,
};

mkdirSync(EVIDENCE_DIR, { recursive: true });

async function readCoreSnapshot(page: Page): Promise<CoreSnapshot> {
	const captured = await page.evaluate((storageKey) => {
		const stored = localStorage.getItem(storageKey);
		if (!stored) {
			return { preferences: {}, requests: [] };
		}
		return JSON.parse(stored);
	}, STORAGE_KEY);
	return z
		.object({
			preferences: z.record(z.string(), z.string()),
			requests: z.array(
				z.object({
					body: z.json(),
					method: z.string(),
					path: z.string(),
					status: z.number(),
				})
			),
		})
		.parse(captured);
}

async function readRulesConfig(page: Page): Promise<AgentRulesConfig | null> {
	const snapshot = await readCoreSnapshot(page);
	const raw = snapshot.preferences[PREFERENCE_KEY];
	return raw
		? z
				.object({
					applyMode: z.enum(["auto", "always", "manual"]),
					autoInject: z.boolean(),
					enabled: z.boolean(),
					rules: z.array(
						z.object({
							enabled: z.boolean(),
							id: z.string(),
							mode: z.enum(["auto", "always", "manual"]),
							text: z.string(),
						})
					),
					turnsPerPlan: z.number(),
				})
				.parse(JSON.parse(raw))
		: null;
}

async function openAgentEditRoute(page: Page, query = "") {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) =>
		pageErrors.push(error.stack ?? error.message)
	);
	await page.setViewportSize({ height: 1100, width: 1440 });
	await page.goto(`${PAGE_URL}${query}`);
	await expect(
		page.getByRole("status", { exact: true, name: "Loading" })
	).toBeVisible();
	try {
		await expect(
			page.getByText("Agent base rules", { exact: true })
		).toBeVisible();
	} catch (error) {
		const bodyText = await page.locator("body").innerText();
		throw new Error(
			`${String(error)}\nBrowser page errors: ${pageErrors.join(" | ")}\nPage body: ${bodyText}`
		);
	}
	await expect(
		page.getByText("architecture.mdc", { exact: true })
	).toBeVisible();
	await expect(page.getByLabel("Search agent settings")).toBeVisible();
}

async function chooseMode(page: Page, triggerId: string, option: string) {
	const trigger = page.locator(`#${triggerId}`);
	await expect(trigger).toBeVisible();
	await trigger.click();
	await page.getByRole("option", { exact: true, name: option }).click();
}

async function saveScreenshot(page: Page, name: string) {
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, name),
	});
}

async function runSharedRulesHook(page: Page) {
	const snapshot = await readCoreSnapshot(page);
	const preference = snapshot.preferences[PREFERENCE_KEY];
	if (!preference) {
		throw new Error(`Core fixture did not persist ${PREFERENCE_KEY}`);
	}
	const calls: string[] = [];
	const context = {
		agent_id: AGENT_ID,
		conversation_id: "rules-panel-proof-conversation",
		messages: [{ role: "user", content: "Review the implementation." }],
	};
	const host = {
		getPreference: async ({ key }: { key: string }) => {
			calls.push(key);
			return key === PREFERENCE_KEY ? preference : null;
		},
		storage: {
			get: async () => "0",
			set: async () => undefined,
		},
	};
	const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
	const code = readFileSync(RULES_HOOK_PATH, "utf8");
	const directive = await new AsyncFunction("ctx", "host", code)(context, host);
	return { calls, directive };
}

test.describe.configure({ mode: "serial", timeout: 60_000 });

test("saves global rule controls to the shared per-agent preference and reloads them", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openAgentEditRoute(page, "?reset=true");

	await page.getByRole("checkbox", { name: "Enable rules" }).click();
	await page.getByRole("checkbox", { name: "Auto-injected context" }).click();
	await chooseMode(page, "rules-apply-mode", "Always");
	await page.getByLabel("Turns per plan").fill("4");

	const expected: AgentRulesConfig = {
		...INITIAL_CONFIG,
		applyMode: "always",
		autoInject: false,
		enabled: false,
		turnsPerPlan: 4,
	};
	await expect.poll(() => readRulesConfig(page)).toEqual(expected);
	const snapshot = await readCoreSnapshot(page);
	const writes = snapshot.requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path === `/api/preferences/${PREFERENCE_KEY}`
	);
	expect(writes.length).toBeGreaterThan(0);
	expect(writes.at(-1)).toEqual({
		body: { value: JSON.stringify(expected) },
		method: "PUT",
		path: `/api/preferences/${PREFERENCE_KEY}`,
		status: 200,
	});
	await saveScreenshot(
		page,
		"desktop-rules-agent-edit-panel-global-controls.png"
	);

	await page.getByRole("button", { exact: true, name: "Cancel" }).click();
	await expect(page.getByTestId("agent-list-returned")).toBeVisible();
	await expect.poll(() => readRulesConfig(page)).toEqual(expected);

	await page.goto(PAGE_URL);
	await expect(
		page.getByRole("status", { exact: true, name: "Loading" })
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Enable rules" })
	).not.toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Auto-injected context" })
	).not.toBeChecked();
	await expect(page.locator("#rules-apply-mode")).toContainText("Always");
	await expect(page.getByLabel("Turns per plan")).toHaveValue("4");
	await expect.poll(() => readRulesConfig(page)).toEqual(expected);
	expect(pageErrors).toEqual([]);
});

test("adds, edits, disables, and removes rules, then checks the shared hook contract", async ({
	page,
}) => {
	await openAgentEditRoute(page, "?reset=true");

	const existingEnabled = page.getByRole("checkbox", {
		name: "Enable rule existing-team-rule",
	});
	await existingEnabled.click();
	const disabledExistingConfig: AgentRulesConfig = {
		...INITIAL_CONFIG,
		rules: INITIAL_CONFIG.rules.map((rule) => ({ ...rule, enabled: false })),
	};
	await expect
		.poll(() => readRulesConfig(page))
		.toEqual(disabledExistingConfig);
	const disabledRuleWrite = (await readCoreSnapshot(page)).requests
		.filter(
			(request) =>
				request.method === "PUT" &&
				request.path === `/api/preferences/${PREFERENCE_KEY}`
		)
		.at(-1);
	expect(disabledRuleWrite).toEqual({
		body: { value: JSON.stringify(disabledExistingConfig) },
		method: "PUT",
		path: `/api/preferences/${PREFERENCE_KEY}`,
		status: 200,
	});

	await page.reload();
	await expect(
		page.getByRole("status", { exact: true, name: "Loading" })
	).toBeVisible();
	await expect(
		page.getByText("Agent base rules", { exact: true })
	).toBeVisible();
	await expect(
		page.getByRole("checkbox", { name: "Enable rule existing-team-rule" })
	).not.toBeChecked();
	await expect
		.poll(() => readRulesConfig(page))
		.toEqual(disabledExistingConfig);
	await saveScreenshot(
		page,
		"desktop-rules-agent-edit-panel-rule-disabled-persisted.png"
	);

	const existingText = page.getByRole("textbox", { name: "Rule text" }).first();
	await existingText.fill("Edited team instruction for review.");
	await chooseMode(page, "rule-mode-existing-team-rule", "Always");
	await page.getByRole("button", { exact: true, name: "Add rule" }).click();

	const addedRuleToggle = page.getByRole("checkbox", {
		name: /^Enable rule rule-/u,
	});
	await expect(addedRuleToggle).toBeVisible();
	const addedRuleLabel = await addedRuleToggle.getAttribute("aria-label");
	const addedRuleId = addedRuleLabel?.replace("Enable rule ", "");
	expect(addedRuleId).toMatch(/^rule-\d+-1$/u);
	const ruleInputs = page.getByRole("textbox", { name: "Rule text" });
	await ruleInputs.last().fill("Always preserve the reviewed API boundary.");
	await chooseMode(page, `rule-mode-${addedRuleId}`, "Always");

	const injected = await runSharedRulesHook(page);
	expect(injected.calls).toEqual([PREFERENCE_KEY]);
	expect(injected.directive).toMatchObject({
		kind: "rewrite",
		messages: [
			{
				role: "user",
				content: expect.stringContaining(
					"Always preserve the reviewed API boundary."
				),
			},
		],
	});

	await chooseMode(page, `rule-mode-${addedRuleId}`, "Manual");
	await page.getByRole("button", { name: "Delete rule" }).first().click();
	await expect(
		page.getByRole("checkbox", { name: "Enable rule existing-team-rule" })
	).toHaveCount(0);

	const expected: AgentRulesConfig = {
		...INITIAL_CONFIG,
		rules: [
			{
				enabled: true,
				// SAFETY: the earlier synchronous native toMatch assertion rejects non-strings;
				// addedRuleId is that same immutable local value throughout these awaited actions.
				id: addedRuleId as string,
				mode: "manual",
				text: "Always preserve the reviewed API boundary.",
			},
		],
	};
	await expect.poll(() => readRulesConfig(page)).toEqual(expected);
	await saveScreenshot(
		page,
		"desktop-rules-agent-edit-panel-rule-lifecycle.png"
	);

	await page.reload();
	await expect(
		page.getByRole("checkbox", { name: `Enable rule ${addedRuleId}` })
	).toBeChecked();
	await expect(page.getByRole("textbox", { name: "Rule text" })).toHaveValue(
		"Always preserve the reviewed API boundary."
	);
	await expect(page.locator(`#rule-mode-${addedRuleId}`)).toContainText(
		"Manual"
	);
	await expect.poll(() => readRulesConfig(page)).toEqual(expected);
});

test("shows rejected saves, preserves the stored config, and restores it after reload", async ({
	page,
}) => {
	await openAgentEditRoute(page, "?reset=true");
	await page.evaluate(() => {
		window.__rulesAgentEditPanelProof?.armNextPreferenceWriteFailure();
	});
	await page.getByRole("checkbox", { name: "Enable rules" }).click();
	await expect(
		page.getByText("Could not save rules", { exact: true })
	).toBeVisible();

	const failedSnapshot = await readCoreSnapshot(page);
	const failedWrite = failedSnapshot.requests
		.filter(
			(request) =>
				request.method === "PUT" &&
				request.path === `/api/preferences/${PREFERENCE_KEY}`
		)
		.at(-1);
	expect(failedWrite).toEqual({
		body: {
			value: JSON.stringify({ ...INITIAL_CONFIG, enabled: false }),
		},
		method: "PUT",
		path: `/api/preferences/${PREFERENCE_KEY}`,
		status: 503,
	});
	await expect.poll(() => readRulesConfig(page)).toEqual(INITIAL_CONFIG);
	await saveScreenshot(page, "desktop-rules-agent-edit-panel-save-failure.png");

	await page.reload();
	await expect(
		page.getByRole("checkbox", { name: "Enable rules" })
	).toBeChecked();
	await expect.poll(() => readRulesConfig(page)).toEqual(INITIAL_CONFIG);

	await page.getByRole("checkbox", { name: "Enable rules" }).click();
	await expect
		.poll(() => readRulesConfig(page))
		.toEqual({
			...INITIAL_CONFIG,
			enabled: false,
		});
	await expect(
		page.getByText("Could not save rules", { exact: true })
	).toHaveCount(0);
	await saveScreenshot(
		page,
		"desktop-rules-agent-edit-panel-save-recovered.png"
	);
});

test("locks every Rules editor action for a locked agent", async ({ page }) => {
	await openAgentEditRoute(page, "?reset=true&locked=true");

	await expect(
		page.getByRole("checkbox", { name: "Enable rules" })
	).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: "Auto-injected context" })
	).toBeDisabled();
	await expect(page.locator("#rules-apply-mode")).toBeDisabled();
	await expect(page.getByLabel("Turns per plan")).toBeDisabled();
	await expect(
		page.getByRole("button", { exact: true, name: "Add rule" })
	).toBeDisabled();
	await expect(
		page.getByRole("checkbox", { name: "Enable rule existing-team-rule" })
	).toBeDisabled();
	await expect(page.getByRole("textbox", { name: "Rule text" })).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Delete rule" })
	).toBeDisabled();
	await expect(page.locator("#rule-mode-existing-team-rule")).toBeDisabled();
	await expect.poll(() => readRulesConfig(page)).toEqual(INITIAL_CONFIG);

	const writes = (await readCoreSnapshot(page)).requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path === `/api/preferences/${PREFERENCE_KEY}`
	);
	expect(writes).toEqual([]);
	await saveScreenshot(page, "desktop-rules-agent-edit-panel-locked.png");
});
