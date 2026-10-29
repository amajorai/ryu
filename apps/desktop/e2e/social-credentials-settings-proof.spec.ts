import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { SettingsResponse } from "../../../apps-store/social/ui/src/types.ts";

const evidenceDirectory = path.resolve(
	import.meta.dirname,
	"../../../docs/proof/test-coverage-sweep-20260924/evidence"
);
const envOnlyThreadsToken = "fixture-env-only-token-never-valid";
const firstDummyPassword = "dummy-only-bsky-app-password-001";

interface SocialBridgeCall {
	body?: unknown;
	method?: string;
	path: string;
}

declare global {
	interface Window {
		__socialCredentialsSettingsProof?: { calls: SocialBridgeCall[] };
	}
}

async function readSettings(page: Page): Promise<SettingsResponse> {
	const response = await page.request.get(
		"/__social/settings?workspace_id=default"
	);
	expect(response.ok()).toBe(true);
	return await response.json();
}

async function bridgeCalls(page: Page): Promise<SocialBridgeCall[]> {
	return page.evaluate(
		() => window.__socialCredentialsSettingsProof?.calls ?? []
	);
}

async function clickAndObserveDisabled(button: Locator) {
	const disabledWhilePending = button.evaluate(
		(element) =>
			new Promise<boolean>((resolve) => {
				const target =
					/* SAFETY: The only callers pass the actual mounted CredentialsSettings Save native Button locators to this pending-state observer. Those authored controls use the default native button, whose disabled property is observed; no arbitrary Locator element is admitted. */ element as HTMLButtonElement;
				let observer: MutationObserver | null = null;
				let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
				const finish = (disabled: boolean) => {
					observer?.disconnect();
					if (timer !== undefined) {
						clearTimeout(timer);
					}
					resolve(disabled);
				};
				observer = new MutationObserver(() => {
					if (target.disabled) {
						finish(true);
					}
				});
				observer.observe(target, {
					attributes: true,
					attributeFilter: ["disabled"],
				});
				if (target.disabled) {
					finish(true);
					return;
				}
				timer = globalThis.setTimeout(() => finish(target.disabled), 1500);
			})
	);
	const click = button.click();
	const disabled = await disabledWhilePending;
	await click;
	return disabled;
}

function fieldCard(page: Page, label: string) {
	return page
		.locator("div.rounded-lg.border.bg-card.p-3")
		.filter({ has: page.getByText(label, { exact: true }) });
}

async function clearTransientToasts(page: Page) {
	await expect(page.getByRole("status")).toHaveCount(0);
}

async function saveScreenshot(page: Page, filename: string) {
	await mkdir(evidenceDirectory, { recursive: true });
	await page.screenshot({
		animations: "disabled",
		path: path.join(evidenceDirectory, filename),
	});
}

test("credentials stay write-only, patch one field at a time, confirm replace/clear, and reload", async ({
	page,
}) => {
	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await page.getByRole("tab", { name: "Credentials" }).click();
	await expect(
		page.getByRole("heading", { name: "Credentials" })
	).toBeVisible();

	const initial = await readSettings(page);
	expect(initial.node.bluesky_app_password_set).toBe(false);
	expect(initial.node.bluesky_app_password_source).toBe("unset");
	expect(initial.node.threads_access_token_set).toBe(true);
	expect(initial.node.threads_access_token_source).toBe("env");
	expect(JSON.stringify(initial)).not.toContain(envOnlyThreadsToken);

	const handleCard = fieldCard(page, "Bluesky handle");
	const handleInput = page.getByLabel("Bluesky handle", { exact: true });
	const handleSave = handleCard.getByRole("button", {
		name: "Save",
		exact: true,
	});
	await expect(handleInput).toHaveValue("");
	await expect(handleSave).toBeDisabled();
	await handleInput.fill("unit.bsky.social");
	await expect(handleSave).toBeEnabled();
	const failHandleSave = await page.request.post(
		"/__proof/fail-next-settings-patch"
	);
	expect(failHandleSave.ok()).toBe(true);
	expect(await clickAndObserveDisabled(handleSave)).toBe(true);
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "Fixture rejected the first credential write." })
	).toBeVisible();
	await expect(handleInput).toHaveValue("unit.bsky.social");
	expect((await readSettings(page)).node.bluesky_handle).toBeNull();
	await handleSave.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Bluesky handle saved" }).last()
	).toContainText("Bluesky handle saved");
	expect((await readSettings(page)).node.bluesky_handle).toBe(
		"unit.bsky.social"
	);
	await expect(handleSave).toBeDisabled();

	const threadsIdCard = fieldCard(page, "Threads user id");
	const threadsIdInput = page.getByLabel("Threads user id", { exact: true });
	const threadsIdSave = threadsIdCard.getByRole("button", {
		name: "Save",
		exact: true,
	});
	await threadsIdInput.fill("12345678901234");
	await expect(threadsIdSave).toBeEnabled();
	await threadsIdSave.click();
	await expect(
		page.getByRole("status").filter({ hasText: "Threads user id saved" }).last()
	).toContainText("Threads user id saved");
	expect((await readSettings(page)).node.threads_user_id).toBe(
		"12345678901234"
	);
	await expect(threadsIdSave).toBeDisabled();

	const blueskySecretCard = fieldCard(page, "Bluesky app password");
	const blueskySecret = page.getByLabel("Bluesky app password", {
		exact: true,
	});
	const passwordSave = blueskySecretCard.getByRole("button", {
		name: "Save",
		exact: true,
	});
	await expect(blueskySecret).toHaveAttribute("type", "password");
	await expect(blueskySecret).toHaveValue("");
	await expect(passwordSave).toBeDisabled();
	await expect(
		blueskySecretCard.getByRole("button", { name: /show|reveal/i })
	).toHaveCount(0);
	await blueskySecret.fill(firstDummyPassword);
	await expect(blueskySecret).toHaveAttribute("type", "password");
	await expect(passwordSave).toBeEnabled();
	await passwordSave.click();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Bluesky app password saved" })
			.last()
	).toContainText("Bluesky app password saved");
	await expect(blueskySecret).toHaveValue("");
	await expect(blueskySecretCard).toContainText("Configured");
	const savedSecretSettings = await readSettings(page);
	expect(savedSecretSettings.node.bluesky_app_password_set).toBe(true);
	expect(savedSecretSettings.node.bluesky_app_password_source).toBe("stored");
	expect(JSON.stringify(savedSecretSettings)).not.toContain(firstDummyPassword);
	expect(await page.locator("body").innerText()).not.toContain(
		firstDummyPassword
	);

	const callsBeforeReload = await bridgeCalls(page);
	await page.reload();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await page.getByRole("tab", { name: "Credentials" }).click();
	await expect(page.getByLabel("Bluesky handle", { exact: true })).toHaveValue(
		"unit.bsky.social"
	);
	await expect(page.getByLabel("Threads user id", { exact: true })).toHaveValue(
		"12345678901234"
	);
	const reloadedSecretCard = fieldCard(page, "Bluesky app password");
	const reloadedSecret = page.getByLabel("Bluesky app password", {
		exact: true,
	});
	await expect(reloadedSecret).toHaveAttribute("type", "password");
	await expect(reloadedSecret).toHaveValue("");
	await expect(reloadedSecretCard).toContainText("Configured");
	const threadsTokenCard = fieldCard(page, "Threads access token");
	await expect(threadsTokenCard).toContainText(
		"From RYU_SOCIAL_THREADS_ACCESS_TOKEN"
	);
	await expect(
		threadsTokenCard.getByRole("button", { name: "Save" })
	).toHaveCount(0);
	await expect(
		threadsTokenCard.getByRole("button", { name: "Clear" })
	).toHaveCount(0);
	await expect(
		page.getByLabel("Threads access token", { exact: true })
	).toHaveCount(0);
	expect(await page.locator("body").innerText()).not.toContain(
		envOnlyThreadsToken
	);

	const replacementSecret = "dummy-only-bsky-app-password-002";
	await reloadedSecret.fill(replacementSecret);
	const replaceButton = reloadedSecretCard.getByRole("button", {
		name: "Replace",
		exact: true,
	});
	const patchCallsBeforeCancel = (await bridgeCalls(page)).filter(
		(call) => call.method === "PATCH" && call.path === "/settings"
	).length;
	await replaceButton.click();
	let overwriteDialog = page.getByRole("alertdialog");
	await expect(overwriteDialog).toContainText(
		"Replace the stored Bluesky app password?"
	);
	await expect(overwriteDialog).toContainText("the old one is not recoverable");
	await clearTransientToasts(page);
	await reloadedSecret.evaluate((input) => {
		if (!(input instanceof HTMLInputElement)) {
			throw new Error("Expected proof element to be an HTMLInputElement.");
		}
		return input.blur();
	});
	await saveScreenshot(
		page,
		"social-credentials-settings-replace-confirmation.png"
	);
	await overwriteDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(overwriteDialog).toBeHidden();
	await expect(reloadedSecret).toHaveValue(replacementSecret);
	const afterOverwriteCancel = await readSettings(page);
	expect(afterOverwriteCancel.node.bluesky_app_password_set).toBe(true);
	expect(
		(await bridgeCalls(page)).filter(
			(call) => call.method === "PATCH" && call.path === "/settings"
		).length
	).toBe(patchCallsBeforeCancel);

	await replaceButton.click();
	overwriteDialog = page.getByRole("alertdialog");
	await overwriteDialog
		.getByRole("button", { name: "Replace", exact: true })
		.click();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Bluesky app password replaced" })
			.last()
	).toContainText("Bluesky app password replaced");
	await expect(reloadedSecret).toHaveValue("");
	await expect(reloadedSecretCard).toContainText("Configured");
	const replacedSecretSettings = await readSettings(page);
	expect(replacedSecretSettings.node.bluesky_app_password_set).toBe(true);
	expect(JSON.stringify(replacedSecretSettings)).not.toContain(
		replacementSecret
	);

	const clearButton = reloadedSecretCard.getByRole("button", {
		name: "Clear",
		exact: true,
	});
	await clearButton.click();
	let clearDialog = page.getByRole("alertdialog");
	await expect(clearDialog).toContainText(
		"Clear the stored Bluesky app password?"
	);
	await expect(clearDialog).toContainText(
		"The credential is deleted from this node."
	);
	await clearDialog
		.getByRole("button", { name: "Cancel", exact: true })
		.click();
	await expect(clearDialog).toBeHidden();
	expect((await readSettings(page)).node.bluesky_app_password_set).toBe(true);

	await clearButton.click();
	clearDialog = page.getByRole("alertdialog");
	await clearDialog.getByRole("button", { name: "Clear", exact: true }).click();
	await expect(
		page
			.getByRole("status")
			.filter({ hasText: "Bluesky app password cleared" })
			.last()
	).toContainText("Bluesky app password cleared");
	await expect(reloadedSecret).toHaveValue("");
	await expect(reloadedSecretCard).toContainText("Not set");
	const clearedSettings = await readSettings(page);
	expect(clearedSettings.node.bluesky_app_password_set).toBe(false);
	expect(clearedSettings.node.bluesky_app_password_source).toBe("unset");
	expect(clearedSettings.node.threads_access_token_set).toBe(true);
	expect(clearedSettings.node.threads_access_token_source).toBe("env");
	expect(JSON.stringify(clearedSettings)).not.toContain(firstDummyPassword);
	expect(JSON.stringify(clearedSettings)).not.toContain(replacementSecret);
	expect(JSON.stringify(clearedSettings)).not.toContain(envOnlyThreadsToken);

	const callsAfterReload = await bridgeCalls(page);
	const patches = [
		...callsBeforeReload.filter(
			(call) => call.method === "PATCH" && call.path === "/settings"
		),
		...callsAfterReload.filter(
			(call) => call.method === "PATCH" && call.path === "/settings"
		),
	];
	expect(patches.map((call) => call.body)).toEqual([
		{ node: { bluesky_handle: "unit.bsky.social" }, workspace_id: "default" },
		{ node: { bluesky_handle: "unit.bsky.social" }, workspace_id: "default" },
		{ node: { threads_user_id: "12345678901234" }, workspace_id: "default" },
		{
			node: { bluesky_app_password: firstDummyPassword },
			workspace_id: "default",
		},
		{
			node: { bluesky_app_password: replacementSecret },
			workspace_id: "default",
		},
		{ node: { bluesky_app_password: "" }, workspace_id: "default" },
	]);

	await page.reload();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await page.getByRole("tab", { name: "Credentials" }).click();
	await expect(page.getByLabel("Bluesky handle", { exact: true })).toHaveValue(
		"unit.bsky.social"
	);
	await expect(page.getByLabel("Threads user id", { exact: true })).toHaveValue(
		"12345678901234"
	);
	await expect(
		page.getByLabel("Bluesky app password", { exact: true })
	).toHaveValue("");
	await expect(fieldCard(page, "Bluesky app password")).toContainText(
		"Not set"
	);
	await expect(fieldCard(page, "Threads access token")).toContainText(
		"From RYU_SOCIAL_THREADS_ACCESS_TOKEN"
	);
	await clearTransientToasts(page);
	await saveScreenshot(
		page,
		"social-credentials-settings-redacted-after-clear.png"
	);
});
