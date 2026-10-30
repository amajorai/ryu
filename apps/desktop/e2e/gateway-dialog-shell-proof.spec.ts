import { expect, test } from "@playwright/test";
import {
	evidencePath,
	openDialog,
	readSnapshot,
	STORY_URL,
	waitForSettingsBody,
} from "./gateway-dialog-shell-proof.helpers.ts";

const RESET_EVIDENCE_PATH = evidencePath(
	"security-cloud-20261006/model-defaults-reset.png"
);
const RETRY_EVIDENCE_PATH = evidencePath(
	"test-coverage-sweep-20260924/evidence/gateway-dialog-status-retry.png"
);
const SEARCH_EVIDENCE_PATH = evidencePath(
	"test-coverage-sweep-20260924/evidence/gateway-dialog-search-results.png"
);
const PROVIDER_EVIDENCE_PATH = evidencePath(
	"test-coverage-sweep-20260924/evidence/gateway-dialog-provider-command-center.png"
);
const KEYS_EVIDENCE_PATH = evidencePath(
	"test-coverage-sweep-20260924/evidence/gateway-dialog-provider-keys-saved.png"
);
const LAZY_ENTRY_EVIDENCE_PATH = evidencePath(
	"test-coverage-sweep-20260924/evidence/gateway-dialog-lazy-entry.png"
);

test.describe.configure({ timeout: 90_000 });

test("reset clears coordinator and thread model defaults", async ({ page }) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await openDialog(
		page,
		"reset=true&section=defaults&scopeResetProof=true&freezeStatusPoll=true"
	);
	const dialog = page.locator('[data-slot="dialog-content"]').first();
	const reset = dialog.getByRole("button", { name: "Reset to defaults" });
	await expect(reset).toBeVisible();
	await reset.click();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).calls.filter(
					(call) =>
						call.path === "/api/scope-defaults/global" &&
						call.method === "DELETE"
				).length
		)
		.toBe(1);
	await expect(reset).toHaveCount(0);
	await page.screenshot({
		path: RESET_EVIDENCE_PATH,
		fullPage: true,
	});
});

test("recovers the Gateway status panel after a failed Core request", async ({
	page,
}) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(
		`${STORY_URL}?reset=true&failStatusOnce=true&gatewayDown=true&freezeStatusPoll=true&freezeStatusAfter=2`
	);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(gatewayDialog).toBeVisible();
	await waitForSettingsBody(page);
	const unreachable = "Couldn't reach Core on this computer.";
	await expect(gatewayDialog.getByText(unreachable)).toBeVisible();
	// The raw status line is only copied, never rendered.
	await expect(gatewayDialog.getByText(/status failed: 503/)).toHaveCount(0);
	await expect(
		gatewayDialog.getByRole("button", { name: "Copy details" })
	).toBeVisible();
	const failedRead = await readSnapshot(page);
	expect(
		failedRead.calls.filter((call) => call.path === "/api/gateway/status")
	).toHaveLength(1);
	expect(
		failedRead.calls.filter((call) => call.path === "/api/gateway/config")
	).toHaveLength(0);

	await gatewayDialog.getByRole("button", { name: "Retry" }).click();
	await expect
		.poll(
			async () =>
				(await readSnapshot(page)).calls.filter(
					(call) => call.path === "/api/gateway/status"
				).length
		)
		.toBe(2);
	await expect(gatewayDialog.getByText(unreachable)).toHaveCount(0);
	await expect(
		gatewayDialog.getByRole("heading", {
			name: "Gateway unreachable",
			exact: true,
		})
	).toBeVisible();
	const recovered = await readSnapshot(page);
	expect(
		recovered.calls.filter((call) =>
			["/api/gateway/status", "/api/gateway/config"].includes(call.path)
		)
	).toEqual([
		{ body: null, method: "GET", path: "/api/gateway/status" },
		{ body: null, method: "GET", path: "/api/gateway/status" },
		{ body: null, method: "GET", path: "/api/gateway/config" },
	]);
	await page.screenshot({ fullPage: true, path: RETRY_EVIDENCE_PATH });
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"true"
	);
});

test("the lazy Gateway entry opens on demand and renders its dialog content", async ({
	page,
}) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(
		`${STORY_URL}?reset=true&initialOpen=false&gatewayDown=true&freezeStatusPoll=true`
	);
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(0);

	await page
		.getByRole("button", { name: "Open Gateway settings", exact: true })
		.click();
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(gatewayDialog).toBeVisible();
	await waitForSettingsBody(page);
	await expect(
		gatewayDialog.getByRole("button", { name: "Connections", exact: true })
	).toBeVisible();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Overview", exact: true })
	).toBeVisible();
	await gatewayDialog.screenshot({ path: LAZY_ENTRY_EVIDENCE_PATH });

	await gatewayDialog
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect(gatewayDialog).not.toBeVisible();
});

test("the visible Close control updates the controlled Gateway dialog state", async ({
	page,
}) => {
	await openDialog(page);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await gatewayDialog
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect(gatewayDialog).not.toBeVisible();
});

test("section navigation and settings search open the exact Gateway or App destination", async ({
	page,
}) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await openDialog(page);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();

	await gatewayDialog
		.getByRole("button", { name: "Model routing", exact: true })
		.click();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Model routing", exact: true })
	).toBeVisible();

	const search = gatewayDialog.getByRole("textbox", {
		name: "Search settings",
	});
	await search.fill("Similarity threshold");
	const smartRoutingResult = gatewayDialog.getByRole("button", {
		name: /Similarity threshold/,
	});
	await expect(smartRoutingResult).toBeVisible();
	await expect(smartRoutingResult).toContainText("Smart routing");
	await page.screenshot({ fullPage: true, path: SEARCH_EVIDENCE_PATH });
	await smartRoutingResult.click();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Model routing", exact: true })
	).toBeVisible();
	await expect(search).toHaveValue("");
	await expect(
		gatewayDialog.getByRole("button", {
			name: "Model routing",
			exact: true,
		})
	).toHaveAttribute("data-active", "");

	await search.fill("zz-no-matching-setting-zz");
	await expect(
		gatewayDialog.getByText("No setting matches “zz-no-matching-setting-zz”.", {
			exact: true,
		})
	).toBeVisible();
	await search.fill("");
	await expect(
		gatewayDialog.getByRole("button", { name: "Model routing", exact: true })
	).toBeVisible();
	await expect(gatewayDialog.getByText(/No setting matches/)).toHaveCount(0);

	await search.fill("Animate streaming chat text");
	const appResult = gatewayDialog.getByRole("button", {
		name: /Animate streaming chat text/,
	});
	await expect(appResult).toBeVisible();
	await expect(appResult).toContainText("Motion");
	await appResult.click();
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect(page.getByTestId("app-settings-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("app-settings-state")).toHaveAttribute(
		"data-section",
		"appearance"
	);
	await expect(gatewayDialog).not.toBeVisible();

	await openDialog(page);
	await page
		.locator('[data-slot="dialog-content"]')
		.first()
		.getByRole("button", { name: "App settings", exact: true })
		.click();
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"false"
	);
	await expect(page.getByTestId("app-settings-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(page.getByTestId("app-settings-state")).toHaveAttribute(
		"data-section",
		"general"
	);
});

test("provider command center renders the Gateway-hosted Integrations tab", async ({
	page,
}) => {
	await openDialog(page);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await gatewayDialog
		.getByRole("button", { name: "AI providers", exact: true })
		.click();
	await expect(
		gatewayDialog.getByRole("heading", { name: "AI providers", exact: true })
	).toBeVisible();
	await gatewayDialog
		.getByRole("button", { name: "Open provider command center" })
		.click();
	const providerCommand = page.locator('[data-slot="dialog-content"]').last();
	await expect(
		providerCommand.getByText("OpenAI", { exact: true }).first()
	).toBeVisible();
	await expect(
		providerCommand.getByText(/Failed to load providers/)
	).toHaveCount(0);
	await expect(
		providerCommand.getByRole("heading", { name: "Hugging Face", exact: true })
	).toBeVisible();
	await expect(
		providerCommand.getByRole("heading", {
			name: "Artificial Analysis",
			exact: true,
		})
	).toBeVisible();
	await providerCommand
		.getByRole("heading", { name: "Hugging Face", exact: true })
		.scrollIntoViewIfNeeded();
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await page.screenshot({ fullPage: true, path: PROVIDER_EVIDENCE_PATH });
});

test("closing the nested provider command keeps the parent Gateway dialog open", async ({
	page,
}) => {
	await openDialog(page);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await gatewayDialog
		.getByRole("button", { name: "AI providers", exact: true })
		.click();
	await gatewayDialog
		.getByRole("button", { name: "Open provider command center" })
		.click();
	// Address the nested dialog by its own name: it unmounts on close, so a
	// positional `.last()` would re-resolve to the still-open parent dialog.
	const providerCommand = page.getByRole("dialog", {
		name: "Provider command center",
	});
	await expect(providerCommand).toHaveCount(1);
	await expect(
		providerCommand.getByRole("heading", { name: "Hugging Face", exact: true })
	).toBeVisible();
	await providerCommand.focus();
	await providerCommand.press("Escape");
	await expect(page.getByTestId("gateway-state")).toHaveAttribute(
		"data-open",
		"true"
	);
	await expect(providerCommand).toHaveCount(0);
	await expect(page.locator('[data-slot="dialog-content"]')).toHaveCount(1);
	await expect(gatewayDialog).toBeVisible();
	await expect(
		gatewayDialog.getByRole("heading", { name: "AI providers", exact: true })
	).toBeVisible();
});

test("Gateway navigation opens the direct Integrations and Connections sections", async ({
	page,
}) => {
	await openDialog(page);
	let gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	const integrationsNavigation = gatewayDialog.getByRole("button", {
		name: "Integrations",
		exact: true,
	});
	await integrationsNavigation.click();
	await expect(integrationsNavigation).toHaveAttribute("data-active", "");
	await expect(
		gatewayDialog.getByRole("heading", { name: "Integrations", exact: true })
	).toBeVisible();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Hugging Face", exact: true })
	).toBeVisible();

	const connectionsNavigation = gatewayDialog.getByRole("button", {
		name: "Connections",
		exact: true,
	});
	await connectionsNavigation.click();
	await expect(connectionsNavigation).toHaveAttribute("data-active", "");
	await expect(
		gatewayDialog.getByRole("heading", { name: "Connections", exact: true })
	).toBeVisible();
	await expect(
		gatewayDialog
			.getByRole("heading", {
				name: "Connected devices",
				exact: true,
			})
			.first()
	).toBeVisible();
	await expect(
		gatewayDialog.getByText("No paired devices.", { exact: true })
	).toBeVisible();

	await page.goto(
		`${STORY_URL}?section=access&reset=true&gatewayDown=true&freezeStatusPoll=true`
	);
	await waitForSettingsBody(page);
	gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(
		gatewayDialog.getByRole("heading", { name: "Connections", exact: true })
	).toBeVisible();
	await expect(
		gatewayDialog.getByText("No paired devices.", { exact: true })
	).toBeVisible();
});

test("Gateway key cards show, save, clear, retry, and persist exact preference writes", async ({
	page,
}) => {
	await page.setViewportSize({ height: 980, width: 1440 });
	await page.goto(
		`${STORY_URL}?section=keys&reset=true&gatewayDown=true&freezeStatusPoll=true`
	);
	await waitForSettingsBody(page);
	const gatewayDialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(
		gatewayDialog.getByRole("heading", { name: "API keys", exact: true })
	).toBeVisible();

	// An unmanaged node manages its own client keys here; the read-only
	// "Manage in web" card moved to the provider command center (checked below).
	await expect(
		gatewayDialog.getByRole("heading", {
			name: "Gateway client API keys",
			exact: true,
		})
	).toBeVisible();
	await expect(
		gatewayDialog.getByRole("button", { name: "Manage in web" })
	).toHaveCount(0);

	const composio = gatewayDialog
		.getByRole("heading", { name: "Composio", exact: true })
		.locator("xpath=../..");
	const composioInput = composio.getByRole("textbox");
	await expect(composioInput).toHaveAttribute("type", "password");
	await composio.getByRole("button", { name: "Show key" }).click();
	await expect(composioInput).toHaveAttribute("type", "text");
	await composio.getByRole("button", { name: "Hide key" }).click();
	await expect(composioInput).toHaveAttribute("type", "password");
	await composioInput.fill("  comp_new_key  ");
	await composioInput.press("Enter");
	await expect(composioInput).toHaveValue("");
	await expect
		.poll(
			async () => (await readSnapshot(page)).preferences["composio-api-key"]
		)
		.toBe("comp_new_key");
	await composioInput.fill("comp_button_key");
	await composio.getByRole("button", { name: "Save", exact: true }).click();
	await expect(composioInput).toHaveValue("");
	await expect
		.poll(
			async () => (await readSnapshot(page)).preferences["composio-api-key"]
		)
		.toBe("comp_button_key");
	await composio.getByRole("button", { name: "Composio key actions" }).click();
	await page.getByRole("menuitem", { name: "Clear", exact: true }).click();
	await expect
		.poll(
			async () => (await readSnapshot(page)).preferences["composio-api-key"]
		)
		.toBe("");
	await expect(composio.getByText("No key", { exact: true })).toBeVisible();

	const replicate = gatewayDialog
		.getByRole("heading", { name: "Replicate", exact: true })
		.locator("xpath=../..");
	const replicateInput = replicate.getByRole("textbox");
	await replicate.getByRole("button", { name: "Show key" }).click();
	await replicate.getByRole("button", { name: "Hide key" }).click();
	await replicateInput.fill("  r8_replacement_token  ");
	await page.evaluate(() =>
		window.__gatewayDialogShellProof.armPreferenceFailure("replicate-api-key")
	);
	await replicate.getByRole("button", { name: "Save", exact: true }).click();
	await expect(replicate.getByText(/failed|503/i)).toBeVisible();
	await expect(replicateInput).toHaveValue("  r8_replacement_token  ");
	expect((await readSnapshot(page)).preferences["replicate-api-key"]).toBe(
		"replicate-existing-key"
	);
	await expect(
		replicate.getByRole("button", { name: "Save", exact: true })
	).toBeEnabled();
	await replicate.getByRole("button", { name: "Save", exact: true }).click();
	await expect(replicateInput).toHaveValue("");
	await expect
		.poll(
			async () => (await readSnapshot(page)).preferences["replicate-api-key"]
		)
		.toBe("r8_replacement_token");
	await expect(replicate.getByText("Key set", { exact: true })).toBeVisible();

	const fal = gatewayDialog
		.getByRole("heading", { name: "Fal", exact: true })
		.locator("xpath=../..");
	const falInput = fal.getByRole("textbox");
	await falInput.fill(" fal_new_key ");
	await falInput.press("Enter");
	await expect(falInput).toHaveValue("");
	await expect
		.poll(async () => (await readSnapshot(page)).preferences["fal-api-key"])
		.toBe("fal_new_key");
	await fal.getByRole("button", { name: "Fal key actions" }).click();
	await page.getByRole("menuitem", { name: "Clear", exact: true }).click();
	await expect
		.poll(async () => (await readSnapshot(page)).preferences["fal-api-key"])
		.toBe("");
	await expect(fal.getByText("No key", { exact: true })).toBeVisible();

	const preferenceKeys = [
		"composio-api-key",
		"replicate-api-key",
		"fal-api-key",
	];
	const writes = (await readSnapshot(page)).calls.filter(
		(call) =>
			call.method === "PUT" &&
			preferenceKeys.some((key) =>
				call.path.endsWith(`/api/preferences/${key}`)
			)
	);
	expect(writes).toEqual([
		{
			body: { value: "comp_new_key" },
			method: "PUT",
			path: "/api/preferences/composio-api-key",
		},
		{
			body: { value: "comp_button_key" },
			method: "PUT",
			path: "/api/preferences/composio-api-key",
		},
		{
			body: { value: "" },
			method: "PUT",
			path: "/api/preferences/composio-api-key",
		},
		{
			body: { value: "r8_replacement_token" },
			method: "PUT",
			path: "/api/preferences/replicate-api-key",
		},
		{
			body: { value: "r8_replacement_token" },
			method: "PUT",
			path: "/api/preferences/replicate-api-key",
		},
		{
			body: { value: "fal_new_key" },
			method: "PUT",
			path: "/api/preferences/fal-api-key",
		},
		{
			body: { value: "" },
			method: "PUT",
			path: "/api/preferences/fal-api-key",
		},
	]);
	await page.screenshot({ fullPage: true, path: KEYS_EVIDENCE_PATH });
	await page.reload();
	await waitForSettingsBody(page);
	const reloadedDialog = page.locator('[data-slot="dialog-content"]').first();
	await expect(
		reloadedDialog.getByRole("heading", { name: "API keys", exact: true })
	).toBeVisible();
	await expect(
		reloadedDialog
			.getByRole("heading", { name: "Replicate", exact: true })
			.locator("xpath=../..")
			.getByText("Key set", { exact: true })
	).toBeVisible();
	await expect(
		reloadedDialog
			.getByRole("heading", { name: "Fal", exact: true })
			.locator("xpath=../..")
			.getByText("No key", { exact: true })
	).toBeVisible();

	await reloadedDialog
		.getByRole("button", { name: "AI providers", exact: true })
		.click();
	await reloadedDialog
		.getByRole("button", { name: "Open provider command center" })
		.click();
	const providerCommand = page.getByRole("dialog", {
		name: "Provider command center",
	});
	await providerCommand.getByRole("button", { name: "Manage in web" }).click();
	await expect
		.poll(async () => (await readSnapshot(page)).tauriCalls.at(-1) ?? null)
		.toEqual({
			command: "open_external",
			args: { url: "http://localhost:3001/organizations" },
		});
});
