import { expect, test } from "@playwright/test";
import {
	AGENT_ID,
	CLASSIFY_MODEL_ID,
	capture,
	chooseOption,
	installPreferenceFixture,
	LEGACY_PREFERENCE_PATH,
	OTHER_AGENT_ID,
	openProof,
	preferenceReads,
	preferenceWrites,
	routeConfig,
	writtenPreference,
} from "./agent-smart-route-override-proof.fixture.ts";

test("read and save permission failures preserve the per-agent draft and sibling scope", async ({
	page,
}) => {
	const siblingConfig = routeConfig({
		enabled: true,
		router_type: "random",
		rules: [
			{ description: "Sibling route", model: "provider/sibling", weight: 2 },
		],
	});
	const fixture = await installPreferenceFixture(page, {
		initialMap: { [OTHER_AGENT_ID]: siblingConfig },
		deniedReads: 1,
		deniedWrites: 1,
	});
	await openProof(page);
	await expect(page.getByRole("alert")).toContainText(
		"Could not load per-agent routing"
	);
	expect(preferenceReads(fixture).map((call) => call.status)).toEqual([403]);
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	const enabledSwitch = page.getByRole("switch", {
		name: "Override model routing for this agent",
	});
	await expect(enabledSwitch).not.toBeChecked();
	expect(preferenceReads(fixture).map((call) => call.status)).toEqual([
		403, 200,
	]);
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeVisible();

	await enabledSwitch.click();
	const classifierModel = page.getByLabel("Classifier model");
	await expect(
		page.getByRole("button", { name: "Use it", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Use it", exact: true }).click();
	await expect(classifierModel).toHaveValue(CLASSIFY_MODEL_ID);
	await classifierModel.fill("  openrouter/route-classifier  ");
	await page.getByRole("button", { name: "Add rule", exact: true }).click();
	await page
		.getByPlaceholder("When the request is about… (plain language)")
		.fill("  coding requests  ");
	await page
		.getByPlaceholder("Route to model id (e.g. claude-sonnet-4-5)")
		.fill("  openrouter/sonnet  ");
	await page
		.getByLabel("Default model when no rule matches")
		.fill("  openrouter/haiku  ");

	const save = page.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(page.getByText(/This node denied the change/)).toBeVisible();
	await expect(save).toBeEnabled();
	expect(preferenceWrites(fixture).map((call) => call.status)).toEqual([403]);
	expect(fixture.state.routeMap).toEqual({
		[OTHER_AGENT_ID]: siblingConfig,
	});
	await capture(page, "desktop-agent-smart-route-save-permission-retry.png");

	await save.click();
	await expect.poll(() => fixture.state.routeMap[AGENT_ID]).toBeDefined();
	const expectedConfig = routeConfig({
		enabled: true,
		classifier_model: "openrouter/route-classifier",
		default_model: "openrouter/haiku",
		rules: [
			{
				description: "coding requests",
				model: "openrouter/sonnet",
				weight: 1,
			},
		],
	});
	expect(fixture.state.routeMap).toEqual({
		[OTHER_AGENT_ID]: siblingConfig,
		[AGENT_ID]: expectedConfig,
	});
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
	]);
	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Override model routing for this agent" })
	).toBeChecked();
	await expect(page.getByLabel("Classifier model")).toHaveValue(
		"openrouter/route-classifier"
	);
	await expect(
		page.getByPlaceholder("When the request is about… (plain language)")
	).toHaveValue("coding requests");
	await expect(
		page.getByLabel("Default model when no rule matches")
	).toHaveValue("openrouter/haiku");
	await capture(page, "desktop-agent-smart-route-saved-readback.png");

	await page
		.getByRole("switch", { name: "Override model routing for this agent" })
		.click();
	await save.click();
	await expect
		.poll(() => Object.keys(fixture.state.routeMap))
		.toEqual([OTHER_AGENT_ID]);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
		{ [OTHER_AGENT_ID]: siblingConfig, [AGENT_ID]: expectedConfig },
		{ [OTHER_AGENT_ID]: siblingConfig },
	]);
	expect(preferenceWrites(fixture).map((call) => call.status)).toEqual([
		403, 200, 200,
	]);
	expect(preferenceReads(fixture).map((call) => call.status)).toEqual([
		403, 200, 200, 200, 200, 200,
	]);
	expect(fixture.outsideRequests).toEqual([]);
	await capture(page, "desktop-agent-smart-route-cleared-scope.png");
});

test("classifier strategies and similarity threshold persist exact model settings", async ({
	page,
}) => {
	const initialConfig = routeConfig({
		enabled: true,
		classifier_model: "openrouter/classifier-small",
	});
	const fixture = await installPreferenceFixture(page, {
		initialMap: { [AGENT_ID]: initialConfig },
	});
	await openProof(page);
	const strategy = page.getByLabel("Strategy");
	await chooseOption(page, "Strategy", "Embedding");
	await page.getByLabel("Embedding model").fill("  local/embed-v2  ");
	const threshold = page.getByRole("slider", { name: "Similarity threshold" });
	await threshold.press("ArrowRight");
	await expect(threshold).toHaveAttribute("aria-valuenow", "0.4");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.strategy)
		.toBe("embedding");
	const embeddingConfig = routeConfig({
		...initialConfig,
		strategy: "embedding",
		embedding_model: "local/embed-v2",
		similarity_threshold: 0.4,
	});
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(embeddingConfig);
	await capture(page, "desktop-agent-smart-route-embedding.png");

	await chooseOption(page, "Strategy", "Keyword");
	await expect(page.getByLabel("Embedding model")).toHaveCount(0);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const keywordConfig = { ...embeddingConfig, strategy: "keyword" };
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.strategy)
		.toBe("keyword");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(keywordConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: embeddingConfig },
		{ [AGENT_ID]: keywordConfig },
	]);
	await page.reload();
	await expect(strategy).toContainText("Keyword");
	await expect(page.getByLabel("Classifier model")).toHaveCount(0);
	expect(fixture.outsideRequests).toEqual([]);
});

test("stage-router and escalation model fields save exact typed values", async ({
	page,
}) => {
	const fixture = await installPreferenceFixture(page, {
		initialMap: { [AGENT_ID]: routeConfig({ enabled: true }) },
	});
	await openProof(page);
	await chooseOption(page, "Router type", /^Stage router/);
	await page.getByLabel("Capable model").fill("  provider/capable  ");
	await page.getByLabel("Efficient model").fill("  provider/efficient  ");
	await chooseOption(page, "Ambiguous-turn default", "Efficient first");
	const confidence = page.getByRole("slider", {
		name: "Signal confidence threshold",
	});
	await confidence.press("ArrowRight");
	await expect(confidence).toHaveAttribute("aria-valuenow", "0.55");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const stageConfig = routeConfig({
		enabled: true,
		router_type: "stage_router",
		stage_capable_model: "provider/capable",
		stage_efficient_model: "provider/efficient",
		stage_picker: "efficient_first",
		stage_confidence_threshold: 0.55,
	});
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("stage_router");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(stageConfig);
	await capture(page, "desktop-agent-smart-route-stage-router.png");

	await chooseOption(page, "Router type", /^Escalation/);
	await page.getByLabel("Weak model").fill("provider/weak");
	await page.getByLabel("Strong model").fill("provider/strong");
	await page.getByLabel("Judge model").fill("provider/judge");
	await page.getByLabel("Confirmations before escalation").fill("4");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	const escalationConfig = {
		...stageConfig,
		router_type: "escalation",
		escalation_weak_model: "provider/weak",
		escalation_strong_model: "provider/strong",
		escalation_judge_model: "provider/judge",
		escalation_confirmations: 4,
	};
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("escalation");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(escalationConfig);
	await capture(page, "desktop-agent-smart-route-escalation.png");

	const routerType = page.getByLabel("Router type");
	await chooseOption(page, "Router type", /^Passthrough/);
	await expect(routerType).toContainText("Passthrough");
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("passthrough");
	const passthroughConfig = {
		...escalationConfig,
		router_type: "passthrough",
	};
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(passthroughConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: stageConfig },
		{ [AGENT_ID]: escalationConfig },
		{ [AGENT_ID]: passthroughConfig },
	]);
	expect(fixture.outsideRequests).toEqual([]);
});

test("random routing validates seed and weights, adds/removes targets, and reloads", async ({
	page,
}) => {
	const fixture = await installPreferenceFixture(page);
	await openProof(page);
	const enabledSwitch = page.getByRole("switch", {
		name: "Override model routing for this agent",
	});
	await enabledSwitch.click();
	await chooseOption(page, "Router type", /^Weighted random/);
	const seed = page.getByLabel("Seed (optional)");
	await seed.fill("-5");
	await expect(seed).toHaveValue("");
	await seed.fill("42");

	const addRule = page.getByRole("button", { name: "Add rule", exact: true });
	await addRule.click();
	await addRule.click();
	await addRule.click();
	const labels = page.getByPlaceholder("Optional target label");
	const models = page.getByPlaceholder(
		"Route to model id (e.g. claude-sonnet-4-5)"
	);
	const weights = page.getByPlaceholder("Relative weight (default 1)");
	await labels.nth(0).fill("heavy target");
	await models.nth(0).fill("provider/heavy");
	await weights.nth(0).fill("");
	await labels.nth(1).fill("light target");
	await models.nth(1).fill("provider/light");
	await weights.nth(1).fill("3.5");
	await labels.nth(2).fill("invalid weight");
	await models.nth(2).fill("provider/ignored");
	await weights.nth(2).fill("-1");
	await expect(
		page.getByRole("button", { name: "Remove rule 3" })
	).toBeVisible();
	await capture(page, "desktop-agent-smart-route-random-rules.png");

	await page.getByRole("button", { name: "Save", exact: true }).click();
	const randomConfig = routeConfig({
		enabled: true,
		router_type: "random",
		random_seed: 42,
		rules: [
			{ description: "heavy target", model: "provider/heavy", weight: 1 },
			{ description: "light target", model: "provider/light", weight: 3.5 },
		],
	});
	await expect
		.poll(() => fixture.state.routeMap[AGENT_ID]?.router_type)
		.toBe("random");
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(randomConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: randomConfig },
	]);
	await page.reload();
	await expect(enabledSwitch).toBeChecked();
	await expect(seed).toHaveValue("42");
	await expect(models).toHaveCount(2);
	await expect(weights.nth(0)).toHaveValue("1");
	await expect(weights.nth(1)).toHaveValue("3.5");

	await addRule.click();
	await expect(
		page.getByRole("button", { name: "Remove rule 3" })
	).toBeVisible();
	await page.getByRole("button", { name: "Remove rule 3" }).click();
	await expect(page.getByRole("button", { name: "Remove rule 3" })).toHaveCount(
		0
	);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => preferenceWrites(fixture).length).toBe(2);
	expect(fixture.state.routeMap[AGENT_ID]).toEqual(randomConfig);
	expect(preferenceWrites(fixture).map(writtenPreference)).toEqual([
		{ [AGENT_ID]: randomConfig },
		{ [AGENT_ID]: randomConfig },
	]);
	expect(fixture.outsideRequests).toEqual([]);
});

test("a legacy Core override loads as the draft and moves to the gateway on save", async ({
	page,
}) => {
	const legacyConfig = routeConfig({
		enabled: true,
		classifier_model: "openrouter/legacy-classifier",
		rules: [{ description: "legacy", model: "provider/legacy", weight: 1 }],
	});
	const fixture = await installPreferenceFixture(page, {
		legacyMap: { [AGENT_ID]: legacyConfig, [OTHER_AGENT_ID]: legacyConfig },
	});
	await openProof(page);
	await expect(
		page.getByRole("switch", { name: "Override model routing for this agent" })
	).toBeChecked();
	await expect(page.getByLabel("Classifier model")).toHaveValue(
		"openrouter/legacy-classifier"
	);
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect
		.poll(() => Object.keys(fixture.state.legacyMap))
		.toEqual([OTHER_AGENT_ID]);
	expect(fixture.state.routeMap).toEqual({ [AGENT_ID]: legacyConfig });

	// Once moved, a later save writes the gateway only.
	await page.getByRole("button", { name: "Save", exact: true }).click();
	await expect.poll(() => preferenceWrites(fixture).length).toBe(2);
	expect(
		fixture.calls.filter(
			(call) => call.path === LEGACY_PREFERENCE_PATH && call.method === "PUT"
		)
	).toHaveLength(1);
	expect(fixture.outsideRequests).toEqual([]);
});
