import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { FallbackRulesProofPublisher } from "./harness/fallback-rules-settings-proof.tsx";

const PAGE_URL = "/fallback-rules-settings-proof.html";
const EVIDENCE_DIR = path.resolve(
	process.cwd(),
	"../../docs/proof/test-coverage-sweep-20260924/evidence"
);

interface ProofWindow extends Window {
	__fallbackRulesProof: FallbackRulesProofPublisher;
}
declare const window: ProofWindow;
type ProofSnapshot = ReturnType<FallbackRulesProofPublisher["snapshot"]>;
type CapturedRequest = ProofSnapshot["calls"][number];

function fallbackSection(page: Page): Locator {
	return page
		.getByRole("heading", {
			name: "Fallback when you're running low",
			exact: true,
		})
		.locator("xpath=../..");
}

function ruleCard(section: Locator, id: string): Locator {
	return section.getByTestId(`fallback-rule-${id}`);
}

async function openRouting(page: Page, query = "reset=true") {
	await page.setViewportSize({ height: 1400, width: 1440 });
	await page.goto(`${PAGE_URL}?${query}`);
	await expect(
		page.getByRole("heading", { name: "Model routing", exact: true })
	).toBeVisible();
	const heading = page.getByRole("heading", {
		name: "Fallback when you're running low",
		exact: true,
	});
	await expect(heading).toBeVisible();
	await heading.scrollIntoViewIfNeeded();
	return fallbackSection(page);
}

async function readSnapshot(page: Page): Promise<ProofSnapshot> {
	return page.evaluate(() =>
		/* SAFETY: fallback-rules-settings-proof.tsx installs __fallbackRulesProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__fallbackRulesProof.snapshot()
	);
}

function policyWrites(snapshot: ProofSnapshot): CapturedRequest[] {
	return snapshot.calls.filter(
		(call) => call.path === "/api/routing/policy" && call.method === "PUT"
	);
}

async function waitForWriteCount(
	page: Page,
	count: number
): Promise<ProofSnapshot> {
	await expect
		.poll(async () => {
			const writes = policyWrites(await readSnapshot(page));
			return writes.length === count && writes.at(-1)?.status !== null;
		})
		.toBe(true);
	return readSnapshot(page);
}

async function chooseOption(
	page: Page,
	trigger: Locator,
	option: string
): Promise<void> {
	await trigger.click();
	await page.getByRole("option", { name: option, exact: true }).click();
}

async function saveScreenshot(page: Page, name: string): Promise<void> {
	await mkdir(EVIDENCE_DIR, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: path.join(EVIDENCE_DIR, name),
	});
}

test.describe.configure({ timeout: 90_000 });

test("opens the real Gateway Model routing section with Core-provided fallback policy", async ({
	page,
}) => {
	await openRouting(
		page,
		"reset=true&scenario=lifecycle&failPolicyReadOnce=true"
	);
	fallbackSection(page);
	await expect(
		page.getByText("Ryu credit", { exact: true }).first()
	).toBeVisible();
	await expect(
		page.getByText("Subscription window", { exact: true })
	).toBeVisible();
	const snapshot = await readSnapshot(page);
	expect(
		snapshot.calls.filter(
			(call) => call.path === "/api/routing/policy" && call.method === "GET"
		)
	).toHaveLength(2);
	await saveScreenshot(page, "desktop-gateway-fallback-rules-loaded.png");
});

test("creates and persists Ryu, provider-credit, and subscription-window rules through the Gateway dialog", async ({
	page,
}) => {
	await openRouting(page, "reset=true&scenario=empty&failPolicyReadOnce=true");
	const section = fallbackSection(page);
	const addRule = section.getByRole("button", {
		name: "Add rule",
		exact: true,
	});
	await expect(section.getByText("No rules yet")).toBeVisible();
	const reads = (await readSnapshot(page)).calls.filter(
		(call) => call.path === "/api/routing/policy" && call.method === "GET"
	);
	expect(reads.map((call) => call.status)).toEqual([503, 200]);
	await addRule.click();
	let snapshot = await waitForWriteCount(page, 1);
	const rule = snapshot.policy.rules[0];
	expect(rule).toMatchObject({
		enabled: true,
		notify: true,
		when: { source: "ryu_credits", below_usd: 5 },
		fallback: {
			agent_id: "",
			model: "",
			provider: "",
		},
	});
	const ruleId = String(rule?.id);
	let card = ruleCard(section, ruleId);
	const ryuThreshold = card.getByLabel("Dollars left, below");
	await page.evaluate(() =>
		/* SAFETY: fallback-rules-settings-proof.tsx installs __fallbackRulesProof before this proof page is evaluated. */ (
			window as ProofWindow
		).__fallbackRulesProof.slowNextWrite()
	);
	await ryuThreshold.selectText();
	await ryuThreshold.pressSequentially("12.5");
	await expect(ryuThreshold).toHaveValue("12.5");
	await expect(ryuThreshold).toBeEnabled();
	expect(policyWrites(await readSnapshot(page))).toHaveLength(1);
	await ryuThreshold.press("Tab");
	await expect
		.poll(async () => policyWrites(await readSnapshot(page)).length)
		.toBe(2);
	await expect(ryuThreshold).toBeDisabled();
	await expect(ryuThreshold).toHaveValue("12.5");
	snapshot = await waitForWriteCount(page, 2);
	await expect(ryuThreshold).toBeEnabled();
	expect(snapshot.policy.rules[0]).toMatchObject({
		id: ruleId,
		when: { source: "ryu_credits", below_usd: 12.5 },
	});

	await chooseOption(
		page,
		card.getByRole("combobox", { name: "When" }),
		"A provider key's credit runs low"
	);
	snapshot = await waitForWriteCount(page, 3);
	expect(snapshot.policy.rules[0]).toMatchObject({
		when: { source: "provider_credits", provider_id: "openai", below_usd: 5 },
	});
	card = ruleCard(section, ruleId);
	await chooseOption(
		page,
		card.getByRole("combobox", { name: "Provider" }),
		"anthropic"
	);
	snapshot = await waitForWriteCount(page, 4);
	await expect(card.getByRole("combobox", { name: "Provider" })).toContainText(
		"anthropic"
	);
	expect(snapshot.policy.rules[0]).toMatchObject({
		when: {
			source: "provider_credits",
			provider_id: "anthropic",
			below_usd: 5,
		},
	});
	const providerThreshold = card.getByLabel("Dollars left, below");
	await providerThreshold.fill("3.75");
	await providerThreshold.press("Tab");
	snapshot = await waitForWriteCount(page, 5);
	expect(snapshot.policy.rules[0]).toMatchObject({
		when: {
			source: "provider_credits",
			provider_id: "anthropic",
			below_usd: 3.75,
		},
	});

	card = ruleCard(section, ruleId);
	await chooseOption(
		page,
		card.getByRole("combobox", { name: "When" }),
		"A subscription window runs low"
	);
	snapshot = await waitForWriteCount(page, 6);
	expect(snapshot.policy.rules[0]).toMatchObject({
		when: {
			source: "subscription_window",
			agent_id: "claude",
			window: "",
			remaining_below_percent: 50,
		},
	});
	card = ruleCard(section, ruleId);
	await chooseOption(
		page,
		card.getByRole("combobox", { name: "Agent" }),
		"codex"
	);
	snapshot = await waitForWriteCount(page, 7);
	await expect(card.getByRole("combobox", { name: "Agent" })).toContainText(
		"codex"
	);
	expect(snapshot.policy.rules[0]?.when).toMatchObject({ agent_id: "codex" });
	card = ruleCard(section, ruleId);
	await chooseOption(
		page,
		card.getByRole("combobox", { name: "Window" }),
		"Weekly"
	);
	snapshot = await waitForWriteCount(page, 8);
	await expect(card.getByRole("combobox", { name: "Window" })).toContainText(
		"Weekly"
	);
	expect(snapshot.policy.rules[0]?.when).toMatchObject({ window: "weekly" });
	card = ruleCard(section, ruleId);
	const percentThreshold = card.getByLabel("Percent left, below");
	await percentThreshold.fill("101");
	await percentThreshold.press("Tab");
	await expect(card.getByRole("alert")).toHaveText(
		"Enter a percent from 0 to 100."
	);
	expect(policyWrites(await readSnapshot(page))).toHaveLength(8);
	await percentThreshold.fill("25");
	await percentThreshold.press("Tab");
	snapshot = await waitForWriteCount(page, 9);
	expect(snapshot.policy.rules[0]).toMatchObject({
		when: {
			source: "subscription_window",
			agent_id: "codex",
			window: "weekly",
			remaining_below_percent: 25,
		},
	});

	card = ruleCard(section, ruleId);
	await card.getByRole("button", { name: "Fallback agent or model" }).click();
	await page
		.getByRole("textbox", { name: "Custom model id" })
		.fill("gpt-4o-mini");
	await page.getByRole("button", { name: "Use this model" }).click();
	snapshot = await waitForWriteCount(page, 10);
	expect(snapshot.policy.rules[0]?.fallback).toMatchObject({
		model: "gpt-4o-mini",
		provider: "",
	});
	card = ruleCard(section, ruleId);
	await card.getByRole("switch", { name: "Rule enabled" }).click();
	snapshot = await waitForWriteCount(page, 11);
	expect(snapshot.policy.rules[0]?.enabled).toBe(false);
	card = ruleCard(section, ruleId);
	await card
		.getByRole("switch", { name: "Notify when this rule fires" })
		.click();
	snapshot = await waitForWriteCount(page, 12);
	expect(snapshot.policy.rules[0]?.notify).toBe(false);

	await addRule.click();
	snapshot = await waitForWriteCount(page, 13);
	const secondRuleId = String(snapshot.policy.rules[1]?.id);
	const secondCard = ruleCard(section, secondRuleId);
	await expect(
		secondCard.getByRole("button", { name: "Move rule up" })
	).toBeEnabled();
	await expect(
		secondCard.getByRole("button", { name: "Move rule down" })
	).toBeDisabled();
	await secondCard.getByRole("button", { name: "Move rule up" }).click();
	snapshot = await waitForWriteCount(page, 14);
	expect(
		snapshot.policy.rules.map(
			(entry: ReturnType<typeof JSON.parse>) => entry.id
		)
	).toEqual([secondRuleId, ruleId]);
	await ruleCard(section, secondRuleId)
		.getByRole("button", { name: "Move rule down" })
		.click();
	snapshot = await waitForWriteCount(page, 15);
	expect(
		snapshot.policy.rules.map(
			(entry: ReturnType<typeof JSON.parse>) => entry.id
		)
	).toEqual([ruleId, secondRuleId]);
	await ruleCard(section, secondRuleId)
		.getByRole("button", { name: "Delete rule" })
		.click();
	snapshot = await waitForWriteCount(page, 16);
	expect(
		snapshot.policy.rules.map(
			(entry: ReturnType<typeof JSON.parse>) => entry.id
		)
	).toEqual([ruleId]);
	expect(policyWrites(snapshot).at(-1)?.body).toEqual({
		rules: snapshot.policy.rules,
	});
	await saveScreenshot(
		page,
		"desktop-gateway-fallback-rules-lifecycle-saved.png"
	);

	await page.reload();
	await openRouting(page, "scenario=empty");
	const restored = ruleCard(fallbackSection(page), ruleId);
	await expect(restored.getByLabel("Percent left, below")).toHaveValue("25");
	await expect(
		restored.getByRole("button", { name: "Fallback agent or model" })
	).toContainText("gpt-4o-mini");
});

test("validates thresholds, retains a failed draft, and retries the exact policy write", async ({
	page,
}) => {
	await openRouting(page, "reset=true&scenario=single&failPolicyWrites=1");
	const section = fallbackSection(page);
	const card = ruleCard(section, "proof-wallet-rule");
	const threshold = card.getByLabel("Dollars left, below");
	await threshold.fill("-0.25");
	await threshold.press("Tab");
	await expect(card.getByRole("alert")).toHaveText(
		"Enter a non-negative USD amount."
	);
	expect(policyWrites(await readSnapshot(page))).toHaveLength(0);
	await saveScreenshot(page, "desktop-gateway-fallback-rules-validation.png");

	await threshold.fill("7.25");
	await threshold.press("Tab");
	await expect(page.getByText("Could not save fallback rules")).toBeVisible();
	await expect(threshold).toHaveValue("7.25");
	let snapshot = await readSnapshot(page);
	let writes = policyWrites(snapshot);
	expect(writes).toHaveLength(1);
	expect(writes[0]?.status).toBe(503);
	expect(snapshot.policy.rules[0]?.when).toMatchObject({
		source: "ryu_credits",
		below_usd: 5,
	});

	await threshold.focus();
	await threshold.press("Tab");
	snapshot = await waitForWriteCount(page, 2);
	writes = policyWrites(snapshot);
	expect(writes[1]?.status).toBe(200);
	expect(writes[1]?.body).toEqual({
		rules: [
			{
				...snapshot.policy.rules[0],
				when: { source: "ryu_credits", below_usd: 7.25 },
			},
		],
	});
	await expect(threshold).toHaveValue("7.25");
	await saveScreenshot(page, "desktop-gateway-fallback-rules-retry-saved.png");

	await page.reload();
	await openRouting(page, "scenario=single");
	await expect(
		ruleCard(fallbackSection(page), "proof-wallet-rule").getByLabel(
			"Dollars left, below"
		)
	).toHaveValue("7.25");
});

test("a member without gateway.configure can read but cannot write fallback rules", async ({
	page,
}) => {
	await openRouting(page, "reset=true&scenario=lifecycle&permission=denied");
	const section = fallbackSection(page);
	await expect(
		page.getByText(/do not have the gateway.configure permission/i)
	).toBeVisible();
	await expect(
		section.getByRole("button", { name: "Add rule", exact: true })
	).toBeDisabled();
	const firstCard = ruleCard(section, "proof-wallet-rule");
	await expect(
		firstCard.getByRole("switch", { name: "Rule enabled" })
	).toBeDisabled();
	await expect(firstCard.getByLabel("Dollars left, below")).toBeDisabled();
	await expect(
		firstCard.getByRole("button", { name: "Delete rule" })
	).toBeDisabled();
	const snapshot = await readSnapshot(page);
	expect(
		snapshot.calls.some(
			(call) => call.path === "/api/control-plane/me/permissions"
		)
	).toBe(true);
	expect(policyWrites(snapshot)).toHaveLength(0);
	await saveScreenshot(page, "desktop-gateway-fallback-rules-read-only.png");
});
