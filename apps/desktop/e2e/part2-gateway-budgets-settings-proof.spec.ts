// Continues gateway-budgets-settings-proof.spec.ts (split under the file token limit); helpers live in gateway-budgets-settings-proof.helpers.ts.

import { expect, test } from "@playwright/test";
import {
	configWrites,
	readProofState,
	screenshotPath,
} from "./gateway-budgets-settings-proof.helpers.ts";

declare const window: Window;

test.describe.configure({ timeout: 60_000 });

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
