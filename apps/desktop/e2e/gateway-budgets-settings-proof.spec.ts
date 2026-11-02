import { expect, test } from "@playwright/test";
import { gatewayBudgetWriteProofSchema } from "./gateway-budget-proof.contracts.ts";
import {
	configWrites,
	readProofState,
	screenshotPath,
} from "./gateway-budgets-settings-proof.helpers.ts";

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
