declare const window: Window;

import path from "node:path";
import { expect, test } from "@playwright/test";

import type { GatewayBudgetConfig } from "../src/lib/api/gateway.ts";
import { gatewayBudgetWriteProofSchema } from "./gateway-budget-proof.contracts.ts";

interface GatewayBudgetsSnapshot {
	budgets: GatewayBudgetConfig;
	requests: { body: unknown; method: string; path: string; status: number }[];
}

function screenshotPath(name: string): string {
	// RYU_PROOF_EVIDENCE_DIR lets a revalidation run keep its screenshots out of
	// the tracked proof ledger; without it the committed evidence is refreshed.
	const override = process.env.RYU_PROOF_EVIDENCE_DIR;
	if (override) {
		return path.join(override, `${name}.png`);
	}
	return path.resolve(
		import.meta.dirname,
		`../../../docs/proof/test-coverage-sweep-20260924/evidence/${name}.png`
	);
}

async function readProofState(page: import("@playwright/test").Page) {
	await page.waitForFunction(() => {
		// Navigation can finish before Vite evaluates the harness module. Wait for
		// its actual snapshot interface before reading the persisted fixture state.
		const proof = (
			window as Window & {
				__gatewayBudgetsProof?: {
					snapshot?: () => GatewayBudgetsSnapshot;
				};
			}
		).__gatewayBudgetsProof;
		return typeof proof?.snapshot === "function";
	});
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-budgets-settings-proof.tsx installs __gatewayBudgetsProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayBudgetsProof: {
						snapshot: () => GatewayBudgetsSnapshot;
					};
				}
			).__gatewayBudgetsProof;
		return proof.snapshot();
	});
}

function configWrites(snapshot: GatewayBudgetsSnapshot) {
	return snapshot.requests.filter(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
}

test.describe.configure({ timeout: 60_000 });

test("per-user rules validate USD bounds, serialize micro-USD, and round-trip every edited field", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-budgets-settings-proof.html");
	await expect(page.getByText("existing-user", { exact: true })).toBeVisible();
	await expect(page.getByText("agent-existing", { exact: true })).toBeVisible();

	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	const dialog = page.getByRole("dialog");
	await expect(
		dialog.getByRole("heading", { name: "Add user budget" })
	).toBeVisible();
	const limit = dialog.getByLabel("Spend cap (USD)");
	await expect(limit).toHaveAttribute("min", "0");
	await expect(limit).toHaveAttribute("step", "0.000001");
	await dialog.getByLabel("User ID").fill(" user_123 ");
	await limit.fill("1.234567");
	await expect(limit).toHaveJSProperty("validity.stepMismatch", false);
	await dialog.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Restrict/ }).click();
	await dialog.getByLabel("Max tokens cap").fill("512");
	await dialog.getByRole("checkbox", { name: "Model calls" }).uncheck();
	await dialog.getByRole("checkbox", { name: "Paid tools" }).uncheck();
	await dialog.getByLabel("Notify when this rule fires").click();
	await page.getByRole("option", { name: /^Email/ }).click();
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	const saved = await readProofState(page);
	const userRule = {
		action: "restrict",
		alert: "email",
		include: { model: false, media: true, tools: false },
		limit: 1_234_567,
		restrict_max_tokens: 512,
	};
	expect(saved.budgets.users.user_123).toEqual(userRule);
	const userWrite = configWrites(saved).at(-1);
	expect(userWrite?.body).toMatchObject({
		budgets: {
			users: {
				"existing-user": saved.budgets.users["existing-user"],
				user_123: userRule,
			},
			agents: saved.budgets.agents,
			session: saved.budgets.session,
		},
	});
	expect(saved.budgets.users["existing-user"]).toMatchObject({
		alert: "fanout",
	});
	expect(saved.budgets.agents["agent-existing"]).toMatchObject({
		limit: 3_000_000,
	});
	expect(saved.budgets.session).toMatchObject({ limit: 4_000_000 });

	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-budgets-per-user-saved"),
	});
	await page.reload();
	await page.getByRole("button", { name: "Edit budget for user_123" }).click();
	const editDialog = page.getByRole("dialog");
	await expect(editDialog.getByLabel("Spend cap (USD)")).toHaveValue(
		"1.234567"
	);
	await expect(editDialog.getByLabel("User ID")).toBeDisabled();
	await expect(
		editDialog.getByRole("checkbox", { name: "Model calls" })
	).not.toBeChecked();
	await expect(
		editDialog.getByRole("checkbox", { name: "Media" })
	).toBeChecked();
	await expect(
		editDialog.getByRole("checkbox", { name: "Paid tools" })
	).not.toBeChecked();
	await expect(editDialog.getByLabel("Max tokens cap")).toHaveValue("512");
	await expect(
		editDialog.getByLabel("Action when spend cap is reached")
	).toContainText("Restrict");
	await expect(
		editDialog.getByLabel("Notify when this rule fires")
	).toContainText("Email");
	const beforeEditCancel = await readProofState(page);
	const writesBeforeEditCancel = configWrites(beforeEditCancel).length;
	await editDialog.getByLabel("Spend cap (USD)").fill("9.99");
	await editDialog.getByRole("button", { name: "Cancel" }).click();
	await expect(editDialog).toHaveCount(0);
	const afterEditCancel = await readProofState(page);
	expect(configWrites(afterEditCancel)).toHaveLength(writesBeforeEditCancel);
	expect(afterEditCancel.budgets.users.user_123).toEqual(userRule);
	await page.getByRole("button", { name: "Edit budget for user_123" }).click();
	const reopenedEdit = page.getByRole("dialog");
	await expect(reopenedEdit.getByLabel("Spend cap (USD)")).toHaveValue(
		"1.234567"
	);
	await reopenedEdit.getByRole("button", { name: "Cancel" }).click();
	expect(browserErrors).toEqual([]);
});

test("Cancel discards new user and agent drafts and reopens with defaults", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	const before = await readProofState(page);
	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	let dialog = page.getByRole("dialog");
	await dialog.getByLabel("User ID").fill("cancelled-user");
	await dialog.getByLabel("Spend cap (USD)").fill("9.99");
	await dialog.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Restrict/ }).click();
	await dialog.getByLabel("Max tokens cap").fill("1024");
	await dialog.getByRole("checkbox", { name: "Model calls" }).uncheck();
	await dialog.getByLabel("Notify when this rule fires").click();
	await page.getByRole("option", { name: /^Email/ }).click();
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	let state = await readProofState(page);
	expect(state.budgets).toEqual(before.budgets);
	expect(configWrites(state)).toEqual([]);

	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("User ID")).toHaveValue("");
	await expect(dialog.getByLabel("Spend cap (USD)")).toHaveValue("1.00");
	await expect(
		dialog.getByLabel("Action when spend cap is reached")
	).toContainText("Notify");
	await expect(
		dialog.getByRole("checkbox", { name: "Model calls" })
	).toBeChecked();
	await expect(dialog.getByLabel("Notify when this rule fires")).toContainText(
		"Silent"
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budget-dialog-create-cancel-reset"),
	});
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();

	await page.getByRole("button", { name: "Add", exact: true }).nth(1).click();
	dialog = page.getByRole("dialog");
	await dialog.getByLabel("Agent ID").click();
	await page.getByRole("option", { name: /Agent Alpha/ }).click();
	await dialog.getByLabel("Spend cap (USD)").fill("3.25");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Add", exact: true }).nth(1).click();
	dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("Agent ID")).toContainText("Select an agent");
	await expect(dialog.getByLabel("Spend cap (USD)")).toHaveValue("1.00");
	await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
	state = await readProofState(page);
	expect(state.budgets).toEqual(before.budgets);
	expect(configWrites(state)).toEqual([]);
});

test("restrict token caps reject non-positive and fractional values before the full config write", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	const before = await readProofState(page);
	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("User ID").fill("restricted-user");
	await dialog.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Restrict/ }).click();
	const tokenCap = dialog.getByLabel("Max tokens cap");
	for (const value of ["0", "-1", "12.5", "9007199254740992"]) {
		await tokenCap.fill(value);
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog.getByRole("alert")).toHaveText(
			"Max tokens cap must be a positive whole number."
		);
		expect(configWrites(await readProofState(page))).toEqual([]);
	}
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budget-restrict-token-cap-validation"),
	});
	await tokenCap.fill("512");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	const saved = await readProofState(page);
	const rule = {
		action: "restrict",
		alert: "silent",
		include: { model: true, media: true, tools: true },
		limit: 1_000_000,
		restrict_max_tokens: 512,
	};
	const expectedBudgets = {
		...before.budgets,
		users: { ...before.budgets.users, "restricted-user": rule },
	};
	expect(saved.budgets).toEqual(expectedBudgets);
	expect(configWrites(saved).at(-1)).toMatchObject({
		body: { budgets: expectedBudgets },
		status: 200,
	});
	await page.reload();
	await page
		.getByRole("button", { name: "Edit budget for restricted-user" })
		.click();
	const edit = page.getByRole("dialog");
	await expect(edit.getByLabel("Max tokens cap")).toHaveValue("512");
	await expect(edit.getByLabel("Spend cap (USD)")).toHaveValue("1");
	await edit.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("rejects missing identity, negative, over-precision, and unsafe caps while accepting the one-micro minimum", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	let dialog = page.getByRole("dialog");
	const userLimit = dialog.getByLabel("Spend cap (USD)");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText("User ID is required.");
	await expect(configWrites(await readProofState(page))).toHaveLength(0);

	await dialog.getByLabel("User ID").fill("minimum-cap-user");
	for (const value of ["-0.01", "0.0000001", "9007199254.740992"]) {
		await userLimit.fill(value);
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await expect(dialog.getByRole("alert")).toHaveText(
			"Spend cap must be a non-negative USD amount (up to 6 decimals)."
		);
		await expect(configWrites(await readProofState(page))).toHaveLength(0);
	}

	await userLimit.fill("0.000001");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	expect(
		(await readProofState(page)).budgets.users["minimum-cap-user"]
	).toMatchObject({
		limit: 1,
	});

	await page.getByRole("button", { name: "Add", exact: true }).nth(1).click();
	dialog = page.getByRole("dialog");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog.getByRole("alert")).toHaveText("Agent ID is required.");
	await expect(configWrites(await readProofState(page))).toHaveLength(1);
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budgets-validation-and-minimum"),
	});
});

test("per-agent rules select a real agent id, allow zero for unlimited, and preserve other scopes", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	await page.getByRole("button", { name: "Add", exact: true }).nth(1).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Agent ID").click();
	await page.getByRole("option", { name: /Agent Alpha/ }).click();
	await dialog.getByLabel("Spend cap (USD)").fill("0");
	await dialog.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Stop \(402\)/ }).click();
	await dialog.getByRole("checkbox", { name: "Media" }).uncheck();
	await dialog.getByLabel("Notify when this rule fires").click();
	await page.getByRole("option", { name: /^Warn/ }).click();
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	const saved = await readProofState(page);
	const agentRule = {
		action: "stop",
		alert: "warn",
		include: { model: true, media: false, tools: true },
		limit: 0,
	};
	expect(saved.budgets.agents["agent-alpha"]).toEqual(agentRule);
	const payload = gatewayBudgetWriteProofSchema.parse(
		configWrites(saved).at(-1)?.body
	);
	expect(payload.budgets).toEqual(saved.budgets);
	expect(saved.budgets.users["existing-user"]).toMatchObject({
		limit: 2_500_001,
		alert: "fanout",
	});
	expect(saved.budgets.session).toMatchObject({
		limit: 4_000_000,
		alert: "warn",
	});
	await page.reload();
	await expect(page.getByText("agent-alpha", { exact: true })).toBeVisible();
	await expect(
		page.getByText(/unlimited · Stop \(402\) · notifies Warn/)
	).toBeVisible();
});

test("downgrade rules use the custom-model picker and trim the saved fallback id", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("User ID").fill("downgrade-user");
	await dialog.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Downgrade/ }).click();
	const modelPicker = dialog.getByRole("button", {
		name: "Downgrade to model",
	});
	await modelPicker.click();
	const modelInput = page.getByRole("textbox", { name: "Custom model id" });
	await expect(modelInput).toBeVisible();
	await modelInput.fill(" gpt-4o-mini ");
	await page.getByRole("button", { name: "Use this model" }).click();
	await expect(modelPicker).toContainText("gpt-4o-mini");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);

	const saved = await readProofState(page);
	const expectedRule = {
		action: "downgrade",
		alert: "silent",
		downgrade_to: "gpt-4o-mini",
		include: { model: true, media: true, tools: true },
		limit: 1_000_000,
	};
	expect(saved.budgets.users["downgrade-user"]).toEqual(expectedRule);
	const payload = gatewayBudgetWriteProofSchema.parse(
		configWrites(saved).at(-1)?.body
	);
	expect(payload.budgets.users["downgrade-user"]).toEqual(expectedRule);
	await page.reload();
	await page
		.getByRole("button", { name: "Edit budget for downgrade-user" })
		.click();
	const edit = page.getByRole("dialog");
	await expect(
		edit.getByRole("button", { name: "Downgrade to model" })
	).toContainText("gpt-4o-mini");
	await edit.getByRole("button", { name: "Cancel" }).click();
	await expect(edit).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budgets-downgrade-model-saved"),
	});
});

test("edits and removes user and agent rows without overwriting sibling budget scopes", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	await page
		.getByRole("button", { name: "Edit budget for existing-user" })
		.click();
	let dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("User ID")).toBeDisabled();
	await expect(dialog.getByLabel("Notify when this rule fires")).toContainText(
		"Fanout"
	);
	await dialog.getByLabel("Spend cap (USD)").fill("2.75");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	let saved = await readProofState(page);
	expect(saved.budgets.users["existing-user"]).toMatchObject({
		limit: 2_750_000,
		alert: "fanout",
	});
	expect(saved.budgets.agents["agent-existing"]).toMatchObject({
		limit: 3_000_000,
	});

	await page
		.getByRole("button", { name: "Edit budget for agent-existing" })
		.click();
	dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("Agent ID")).toBeDisabled();
	await dialog.getByLabel("Spend cap (USD)").fill("3.5");
	await dialog.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Restrict/ }).click();
	await dialog.getByLabel("Max tokens cap").fill("768");
	await dialog.getByRole("button", { name: "Save", exact: true }).click();
	await expect(dialog).toHaveCount(0);
	saved = await readProofState(page);
	expect(saved.budgets.agents["agent-existing"]).toMatchObject({
		action: "restrict",
		alert: "silent",
		limit: 3_500_000,
		restrict_max_tokens: 768,
	});

	await page
		.getByRole("button", { name: "Remove budget for existing-user" })
		.click();
	await expect(page.getByText("existing-user", { exact: true })).toHaveCount(0);
	saved = await readProofState(page);
	expect(saved.budgets.users["existing-user"]).toBeUndefined();
	expect(saved.budgets.agents["agent-existing"]).toMatchObject({
		limit: 3_500_000,
	});
	expect(saved.budgets.session).toMatchObject({ limit: 4_000_000 });

	await page
		.getByRole("button", { name: "Remove budget for agent-existing" })
		.click();
	await expect(page.getByText("agent-existing", { exact: true })).toHaveCount(
		0
	);
	saved = await readProofState(page);
	expect(saved.budgets.agents["agent-existing"]).toBeUndefined();
	expect(saved.budgets.users.user_123).toBeUndefined();
	expect(saved.budgets.session).toMatchObject({ limit: 4_000_000 });
});

test("keeps a failed edit open with the draft intact and retries the identical full-config write", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	const initial = await readProofState(page);
	const expectedRule = {
		action: "stop",
		alert: "email",
		include: { model: false, media: true, tools: true },
		limit: 2_750_000,
	};
	const expectedBudgets = {
		...initial.budgets,
		users: { ...initial.budgets.users, "existing-user": expectedRule },
	};

	await page
		.getByRole("button", { name: "Edit budget for existing-user" })
		.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByLabel("User ID")).toBeDisabled();
	await dialog.getByLabel("Spend cap (USD)").fill("2.75");
	await dialog.getByLabel("Notify when this rule fires").click();
	await page.getByRole("option", { name: /^Email/ }).click();
	await expect(dialog.getByLabel("Notify when this rule fires")).toContainText(
		"Email"
	);

	await page.evaluate(() => {
		/* SAFETY: gateway-budgets-settings-proof.tsx installs __gatewayBudgetsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayBudgetsProof: { failNextConfigWrite: boolean };
			}
		).__gatewayBudgetsProof.failNextConfigWrite = true;
	});
	const save = dialog.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(dialog.getByLabel("Spend cap (USD)")).toHaveValue("2.75");
	await expect(dialog.getByLabel("Notify when this rule fires")).toContainText(
		"Email"
	);
	const failed = await readProofState(page);
	expect(failed.budgets).toEqual(initial.budgets);
	expect(configWrites(failed).at(-1)).toEqual({
		body: { budgets: expectedBudgets },
		method: "PUT",
		path: "/api/gateway/config",
		status: 503,
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budgets-edit-failure-retains-draft"),
	});

	await save.click();
	await expect(dialog).toHaveCount(0);
	const recovered = await readProofState(page);
	expect(recovered.budgets).toEqual(expectedBudgets);
	expect(configWrites(recovered).slice(-2)).toEqual([
		{
			body: { budgets: expectedBudgets },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
		{
			body: { budgets: expectedBudgets },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);
	await page.reload();
	await page
		.getByRole("button", { name: "Edit budget for existing-user" })
		.click();
	const reopened = page.getByRole("dialog");
	await expect(reopened.getByLabel("Spend cap (USD)")).toHaveValue("2.75");
	await expect(
		reopened.getByLabel("Notify when this rule fires")
	).toContainText("Email");
	await reopened.getByRole("button", { name: "Cancel" }).click();
});

test("keeps failed create and removal available with visible errors and retry", async ({
	page,
}) => {
	const browserErrors: string[] = [];
	page.on("pageerror", (error) => browserErrors.push(error.message));
	await page.goto("/gateway-budgets-settings-proof.html");
	const initial = await readProofState(page);
	await page.getByRole("button", { name: "Add", exact: true }).nth(0).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("User ID").fill("retry-user");
	await dialog.getByLabel("Spend cap (USD)").fill("1.25");
	const retryRule = {
		action: "notify",
		alert: "silent",
		include: { model: true, media: true, tools: true },
		limit: 1_250_000,
	};
	const expectedCreateBudgets = {
		...initial.budgets,
		users: { ...initial.budgets.users, "retry-user": retryRule },
	};
	const expectedCreateBody = { budgets: expectedCreateBudgets };
	await page.evaluate(() => {
		/* SAFETY: gateway-budgets-settings-proof.tsx installs __gatewayBudgetsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayBudgetsProof: { failNextConfigWrite: boolean };
			}
		).__gatewayBudgetsProof.failNextConfigWrite = true;
	});
	const save = dialog.getByRole("button", { name: "Save", exact: true });
	await save.click();
	await expect(dialog.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(dialog.getByLabel("User ID")).toHaveValue("retry-user");
	await expect(dialog.getByLabel("Spend cap (USD)")).toHaveValue("1.25");
	const failedCreate = await readProofState(page);
	expect(failedCreate.budgets).toEqual(initial.budgets);
	expect(configWrites(failedCreate).at(-1)).toEqual({
		body: expectedCreateBody,
		method: "PUT",
		path: "/api/gateway/config",
		status: 503,
	});
	await save.click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("retry-user", { exact: true })).toBeVisible();
	const created = await readProofState(page);
	expect(created.budgets).toEqual(expectedCreateBudgets);
	expect(configWrites(created).slice(-2)).toEqual([
		{
			body: expectedCreateBody,
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
		{
			body: expectedCreateBody,
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);

	await page.evaluate(() => {
		/* SAFETY: gateway-budgets-settings-proof.tsx installs __gatewayBudgetsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayBudgetsProof: { failNextConfigWrite: boolean };
			}
		).__gatewayBudgetsProof.failNextConfigWrite = true;
	});
	await page
		.getByRole("button", { name: "Remove budget for retry-user" })
		.click();
	const removalAlert = page.getByRole("alert");
	await expect(removalAlert).toContainText("Couldn't remove budget:");
	await expect(removalAlert).toContainText("/api/gateway/config failed: 503");
	await expect(page.getByText("retry-user", { exact: true })).toBeVisible();
	const failedRemove = await readProofState(page);
	expect(failedRemove.budgets).toEqual(expectedCreateBudgets);
	expect(configWrites(failedRemove).at(-1)).toEqual({
		body: { budgets: initial.budgets },
		method: "PUT",
		path: "/api/gateway/config",
		status: 503,
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budgets-remove-error"),
	});
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByText("retry-user", { exact: true })).toHaveCount(0);
	const removed = await readProofState(page);
	expect(removed.budgets).toEqual(initial.budgets);
	expect(configWrites(removed)).toHaveLength(4);
	expect(configWrites(removed).slice(-2)).toEqual([
		{
			body: { budgets: initial.budgets },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
		{
			body: { budgets: initial.budgets },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);
	expect(browserErrors).toEqual([]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-budgets-remove-retry-recovered"),
	});
});

test("permission-limited budget view disables both scopes without issuing writes", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html?readOnly=true");
	await expect(page.getByText("existing-user", { exact: true })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Add", exact: true }).nth(0)
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add", exact: true }).nth(1)
	).toBeDisabled();
	for (const id of ["existing-user", "agent-existing"]) {
		await expect(
			page.getByRole("button", { name: `Edit budget for ${id}` })
		).toBeDisabled();
		await expect(
			page.getByRole("button", { name: `Remove budget for ${id}` })
		).toBeDisabled();
	}
	await expect(
		page.getByRole("button", { name: "Save", exact: true })
	).toBeDisabled();
	expect(configWrites(await readProofState(page))).toHaveLength(0);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-budgets-read-only"),
	});
});

test("recovers from a failed budget read with an explicit retry", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html?failRead=true");
	await expect(page.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(
		page.getByRole("button", { name: "Retry", exact: true })
	).toBeVisible();
	await page.getByRole("button", { name: "Retry", exact: true }).click();
	await expect(page.getByText("existing-user", { exact: true })).toBeVisible();
	await expect(page.getByText("agent-existing", { exact: true })).toBeVisible();
	const state = await readProofState(page);
	expect(
		state.requests.filter(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "GET"
		)
	).toHaveLength(2);
	await page.screenshot({
		fullPage: true,
		path: screenshotPath("gateway-budgets-read-retry-recovered"),
	});
});

test("session budget turns off at zero, saves all include and action fields, and retries the exact full config", async ({
	page,
}) => {
	await page.goto("/gateway-budgets-settings-proof.html");
	const initial = await readProofState(page);
	const limit = page.getByLabel("Spend cap (USD)");
	const modelCalls = page.getByRole("checkbox", { name: "Model calls" });
	const media = page.getByRole("checkbox", { name: "Media" });
	const paidTools = page.getByRole("checkbox", { name: "Paid tools" });
	const action = page.getByLabel("Action when spend cap is reached");
	const alertTier = page.getByLabel("Notify when this cap fires");
	const save = page.getByRole("button", { name: "Save", exact: true });

	await limit.fill("0");
	await modelCalls.uncheck();
	await media.check();
	await paidTools.uncheck();
	await action.click();
	await page.getByRole("option", { name: /^Restrict/ }).click();
	const maxTokens = page.getByLabel("Max tokens cap");
	await maxTokens.fill("1024");
	await alertTier.click();
	await page.getByRole("option", { name: /^Email/ }).click();

	const disabledSessionRule = {
		action: "restrict",
		alert: "email",
		include: { model: false, media: true, tools: false },
		limit: 0,
		restrict_max_tokens: 1024,
	};
	const disabledBudgets = {
		...initial.budgets,
		session: disabledSessionRule,
	};
	await page.evaluate(() => {
		/* SAFETY: gateway-budgets-settings-proof.tsx installs __gatewayBudgetsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayBudgetsProof: { failNextConfigWrite: boolean };
			}
		).__gatewayBudgetsProof.failNextConfigWrite = true;
	});
	await save.click();
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await expect(limit).toHaveValue("0");
	await expect(modelCalls).not.toBeChecked();
	await expect(media).toBeChecked();
	await expect(paidTools).not.toBeChecked();
	await expect(action).toContainText("Restrict");
	await expect(maxTokens).toHaveValue("1024");
	await expect(alertTier).toContainText("Email");
	const failed = await readProofState(page);
	expect(failed.budgets).toEqual(initial.budgets);
	expect(configWrites(failed).at(-1)).toEqual({
		body: { budgets: disabledBudgets },
		method: "PUT",
		path: "/api/gateway/config",
		status: 503,
	});

	await save.click();
	await expect(
		page.getByText("Saved. Changes take effect immediately.")
	).toBeVisible();
	const disabled = await readProofState(page);
	expect(disabled.budgets).toEqual(disabledBudgets);
	expect(configWrites(disabled).slice(-2)).toEqual([
		{
			body: { budgets: disabledBudgets },
			method: "PUT",
			path: "/api/gateway/config",
			status: 503,
		},
		{
			body: { budgets: disabledBudgets },
			method: "PUT",
			path: "/api/gateway/config",
			status: 200,
		},
	]);

	await page.reload();
	await expect(page.getByLabel("Spend cap (USD)")).toHaveValue("0");
	await expect(
		page.getByRole("checkbox", { name: "Model calls" })
	).not.toBeChecked();
	await expect(page.getByRole("checkbox", { name: "Media" })).toBeChecked();
	await expect(
		page.getByRole("checkbox", { name: "Paid tools" })
	).not.toBeChecked();
	await expect(
		page.getByLabel("Action when spend cap is reached")
	).toContainText("Restrict");
	await expect(page.getByLabel("Max tokens cap")).toHaveValue("1024");
	await expect(page.getByLabel("Notify when this cap fires")).toContainText(
		"Email"
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-session-budget-cap-off-round-trip"),
	});

	await page.getByLabel("Spend cap (USD)").fill("4.25");
	await page.getByLabel("Action when spend cap is reached").click();
	await page.getByRole("option", { name: /^Downgrade/ }).click();
	const modelPicker = page.getByRole("button", {
		name: "Downgrade to model",
	});
	await modelPicker.click();
	const modelInput = page.getByRole("textbox", { name: "Custom model id" });
	await expect(modelInput).toBeVisible();
	await modelInput.fill(" gpt-4o-mini ");
	await page.getByRole("button", { name: "Use this model" }).click();
	await expect(modelPicker).toContainText("gpt-4o-mini");
	await expect(page.getByLabel("Max tokens cap")).toHaveCount(0);

	const enabledSessionRule = {
		action: "downgrade",
		alert: "email",
		downgrade_to: "gpt-4o-mini",
		include: { model: false, media: true, tools: false },
		limit: 4_250_000,
	};
	const enabledBudgets = {
		...disabledBudgets,
		session: enabledSessionRule,
	};
	await save.click();
	await expect(
		page.getByText("Saved. Changes take effect immediately.")
	).toBeVisible();
	const enabled = await readProofState(page);
	expect(enabled.budgets).toEqual(enabledBudgets);
	expect(configWrites(enabled).at(-1)).toEqual({
		body: { budgets: enabledBudgets },
		method: "PUT",
		path: "/api/gateway/config",
		status: 200,
	});

	await page.reload();
	await expect(page.getByLabel("Spend cap (USD)")).toHaveValue("4.25");
	await expect(
		page.getByRole("button", { name: "Downgrade to model" })
	).toContainText("gpt-4o-mini");
	await expect(page.getByLabel("Notify when this cap fires")).toContainText(
		"Email"
	);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: screenshotPath("gateway-session-budget-enabled-downgrade-round-trip"),
	});
});
