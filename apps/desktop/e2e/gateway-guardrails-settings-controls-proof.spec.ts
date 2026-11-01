import { expect, test } from "@playwright/test";
import {
	choose,
	evidencePath,
	failPreferenceWrite,
	guardrailsPatchProofSchema,
	openGuardrails,
	preferenceWrites,
	readProof,
} from "./gateway-guardrails-settings-proof.helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("inspector controls validate numeric bounds, select a custom model, and persist behavior", async ({
	page,
}) => {
	await openGuardrails(page);
	const initial = await readProof(page);
	const inspector = page.getByRole("switch", { name: "Enable LLM inspector" });
	await expect(inspector).not.toBeChecked();
	await inspector.click();
	await expect(
		page.getByText(/inspector is on and pointed at the local classifier/)
	).toBeVisible();
	await choose(page, "Mode", "Injection");
	await choose(page, "Action on flag", "Sanitize");
	const minimum = page.getByLabel("Min characters");
	const timeout = page.getByLabel("Timeout (ms)");
	await minimum.fill("-5");
	await expect(minimum).toHaveValue("0");
	await minimum.fill("52");
	await timeout.fill("n/a");
	await expect(timeout).toHaveValue("0");
	await timeout.fill("5000");
	await page.getByRole("button", { name: "Inspector model" }).click();
	await page
		.getByRole("textbox", { name: "Custom model id" })
		.fill("ollama/qwen2.5:7b");
	await page.getByRole("button", { name: "Use this model" }).click();
	await expect(
		page.getByText(/inspector is on and pointed at the local classifier/)
	).toHaveCount(0);
	const expectedInspector = {
		action: "sanitize",
		enabled: true,
		min_chars: 52,
		mode: "injection",
		model: "ollama/qwen2.5:7b",
		timeout_ms: 5000,
	};
	await page.evaluate(() => {
		/* SAFETY: gateway-guardrails-proof.tsx installs __gatewayGuardrailsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayGuardrailsProof: { failNextConfigWrite: boolean };
			}
		).__gatewayGuardrailsProof.failNextConfigWrite = true;
	});
	const save = page.getByRole("button", { name: "Save guardrails" });
	await save.click();
	await expect(page.getByText("/api/gateway/config failed: 503")).toBeVisible();
	await expect(inspector).toBeChecked();
	await expect(minimum).toHaveValue("52");
	await expect(timeout).toHaveValue("5000");
	await expect(page.getByRole("combobox", { name: "Mode" })).toContainText(
		"Injection"
	);
	await expect(
		page.getByRole("combobox", { name: "Action on flag" })
	).toContainText("Sanitize");
	await expect(
		page.getByRole("button", { name: "Inspector model" })
	).toContainText("ollama/qwen2.5:7b");
	const failed = await readProof(page);
	expect(failed.config.firewall.inspector).toEqual(
		initial.config.firewall.inspector
	);
	const failedWrite = failed.requests
		.filter(
			(request) =>
				request.method === "PUT" && request.path.endsWith("/api/gateway/config")
		)
		.at(-1);
	expect(failedWrite).toMatchObject({
		body: { firewall: { inspector: expectedInspector } },
		status: 503,
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-inspector-write-error"),
	});

	await save.click();
	await expect(page.getByRole("status")).toHaveText("Saved.");

	const saved = await readProof(page);
	const writes = saved.requests.filter(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(writes.slice(-2).map((request) => request.status)).toEqual([503, 200]);
	expect(
		writes
			.slice(-2)
			.map(
				(request) =>
					guardrailsPatchProofSchema.parse(request.body).firewall.inspector
			)
	).toEqual([expectedInspector, expectedInspector]);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-inspector-saved-retry"),
	});

	await page.reload();
	await expect(
		page.getByRole("switch", { name: "Enable LLM inspector" })
	).toBeChecked();
	await expect(page.getByLabel("Min characters")).toHaveValue("52");
	await expect(page.getByLabel("Timeout (ms)")).toHaveValue("5000");
	await expect(page.getByRole("combobox", { name: "Mode" })).toContainText(
		"Injection"
	);
	await expect(
		page.getByRole("combobox", { name: "Action on flag" })
	).toContainText("Sanitize");
	await expect(
		page.getByRole("button", { name: "Inspector model" })
	).toContainText("ollama/qwen2.5:7b");
	expect((await readProof(page)).config.firewall.inspector).toEqual(
		expectedInspector
	);
});

test("inline evaluator binding edits its action and lock through the firewall save", async ({
	page,
}) => {
	await openGuardrails(page);
	const search = page.getByPlaceholder("Search evaluators…");
	await search.fill("Coverage PII");
	const binding = page.getByRole("switch", {
		name: "Enable Coverage PII detector",
	});
	await expect(binding).toBeVisible();
	await expect(binding).not.toBeChecked();
	await binding.click();
	await choose(page, "Coverage PII detector action", "Sanitize");
	await page
		.getByRole("button", { name: "Lock Coverage PII detector field" })
		.click();
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByRole("status")).toHaveText("Saved.");

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(put?.body).toMatchObject({
		firewall: {
			evaluators: [
				{
					enabled: true,
					id: "coverage-pii-detector",
					inlineAction: "sanitize",
					locked: true,
				},
			],
		},
	});
	await page.reload();
	await page.getByPlaceholder("Search evaluators…").fill("Coverage PII");
	await expect(
		page.getByRole("switch", { name: "Enable Coverage PII detector" })
	).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Unlock Coverage PII detector field" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("combobox", { name: "Coverage PII detector action" })
	).toContainText("Sanitize");
	await binding.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: evidencePath("gateway-inline-evaluator-binding-saved"),
		animations: "disabled",
	});
	await openGuardrails(page, "?permission=denied");
	await page.getByPlaceholder("Search evaluators…").fill("Coverage PII");
	await expect(binding).toBeDisabled();
	await expect(
		page.getByRole("combobox", { name: "Coverage PII detector action" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Unlock Coverage PII detector field" })
	).toBeDisabled();
	expect(
		(await readProof(page)).requests.filter(
			(request) =>
				request.method === "PUT" && request.path.endsWith("/api/gateway/config")
		)
	).toEqual([]);
});

test("an agent scope picker writes only its overlay and reloads the selected agent rule", async ({
	page,
}) => {
	await openGuardrails(page, "?withAgent=true");
	await expect
		.poll(async () =>
			(await readProof(page)).requests.some((request) =>
				request.path.endsWith("/api/agents")
			)
		)
		.toBe(true);
	await choose(page, "Scope", "Agent overlay");
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") {
			pageErrors.push(message.text());
		}
	});
	const agent = page.getByRole("button", { name: "Agent", exact: true });
	await expect(agent).toContainText("Agent id (x-ryu-agent-id)");
	await agent.click();
	expect(pageErrors, "agent picker console and page errors").toEqual([]);
	const pickerState = await page.evaluate(() => ({
		body: document.body.innerText.slice(-1200),
		dialogs: Array.from(
			document.querySelectorAll('[data-slot="dialog-content"]')
		).map((dialog) => ({
			text: dialog.textContent?.slice(0, 180) ?? "",
			visible: dialog.getClientRects().length > 0,
		})),
	}));
	expect(pickerState.dialogs.length, JSON.stringify(pickerState)).toBe(2);
	await expect(
		page.getByRole("dialog", { name: "Choose provider and model" })
	).toBeVisible();
	await expect(
		page.getByText("Coverage Agent", { exact: true }).last()
	).toBeVisible();
	await page.getByText("Coverage Agent", { exact: true }).last().click();
	await expect(
		page.getByRole("dialog", { name: "Choose provider and model" })
	).toBeHidden();
	await expect(agent).toContainText("Coverage Agent");
	await choose(page, "Scan outbound", "Off");
	await choose(page, "Policy", "Block");
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByRole("status")).toHaveText("Saved.");
	await page
		.getByRole("heading", { name: "Guardrails", exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-agent-scope-saved"),
	});

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(put?.body).toMatchObject({
		firewall_agent_overlays: {
			"agent-kept": { policy: "block", scan_outbound: true },
			"coverage-agent": { policy: "block", scan_outbound: false },
		},
		firewall_org_overlays: {
			"org-kept": { policy: "sanitize", scan_inbound: true },
		},
	});

	await page.reload();
	await choose(page, "Scope", "Agent overlay");
	const reloadedAgent = page.getByRole("button", {
		name: "Agent",
		exact: true,
	});
	await reloadedAgent.click();
	await expect(
		page.getByPlaceholder("Search providers and models…")
	).toBeVisible();
	await expect(
		page.getByText("Coverage Agent", { exact: true }).last()
	).toBeVisible();
	await page.getByText("Coverage Agent", { exact: true }).last().click();
	await expect(reloadedAgent).toContainText("Coverage Agent");
	await expect(
		page.getByRole("combobox", { name: "Scan outbound" })
	).toContainText("Off");
	expect(pageErrors).toEqual([]);
});

test("permission read-only state disables every firewall writer", async ({
	page,
}) => {
	await openGuardrails(page, "?permission=denied");
	await expect(
		// bc2b817e36 (Ryu Quiet) shortened the read-only banner to one line.
		page.getByText(
			/Read-only\. Ask a workspace admin for gateway\.configure\./u
		)
	).toBeVisible();
	await expect(page.getByRole("switch", { name: "Enabled" })).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Add pattern" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save guardrails" })
	).toBeDisabled();
	const snapshot = await readProof(page);
	expect(
		snapshot.requests.some(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "PUT"
		)
	).toBe(false);
});

test("initial config failure has a working retry path", async ({ page }) => {
	await openGuardrails(page, "?failRead=true");
	await expect(page.getByRole("alert")).toContainText(
		"/api/gateway/config failed: 503"
	);
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	const configReadStatuses = async () =>
		(await readProof(page)).requests
			.filter(
				(request) =>
					request.path.endsWith("/api/gateway/config") &&
					request.method === "GET"
			)
			.map((request) => request.status);
	// The editable guardrails section and the dialog's provider/schema projection
	// each read config on mount. Only the section's failed read is retried here.
	await expect.poll(configReadStatuses).toEqual([503, 200]);
	await page.getByRole("button", { name: "Retry" }).click();
	await expect.poll(configReadStatuses).toEqual([503, 200, 200]);
	await expect(page.getByRole("alert")).toBeHidden();
	await expect(page.getByRole("switch", { name: "Enabled" })).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Save guardrails" })
	).toBeDisabled();
	const snapshot = await readProof(page);
	expect(
		snapshot.requests.filter(
			(request) =>
				request.path.endsWith("/api/gateway/config") && request.method === "PUT"
		)
	).toHaveLength(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-load-retry"),
	});
});

test("unreachable Gateway leaves filters disabled and makes no config write", async ({
	page,
}) => {
	await openGuardrails(page, "?unreachable=true");
	await expect(
		page.getByText("Gateway unreachable, so controls are disabled.")
	).toBeVisible();
	await expect(page.getByLabel("Scope")).toBeDisabled();
	const snapshot = await readProof(page);
	expect(
		snapshot.requests.some(
			(request) =>
				request.path.endsWith("/api/gateway/config") &&
				(request.method === "GET" || request.method === "PUT")
		)
	).toBe(false);
});

test("command scanner rolls back a failed preference write, retries, and reloads the saved mode", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openGuardrails(page);
	const scanner = page
		.locator("#exec-approval-enabled")
		.locator("..")
		.getByRole("switch");
	await expect(scanner).toBeEnabled();
	await expect(scanner).toBeChecked();
	await failPreferenceWrite(page);
	await scanner.click();
	await expect(
		page.getByText("Failed to update.", { exact: true })
	).toBeVisible();
	await expect(scanner).toBeChecked();
	let snapshot = await readProof(page);
	expect(snapshot.preferences["exec-approval-mode"]).toBe("enforce");
	expect(preferenceWrites(snapshot, "exec-approval-mode")).toEqual([
		{
			body: { value: "off" },
			method: "PUT",
			path: "/api/preferences/exec-approval-mode",
			status: 503,
		},
	]);
	await scanner.click();
	await expect(
		page.getByText("Disabled. Saved for this node.", { exact: true })
	).toBeVisible();
	snapshot = await readProof(page);
	expect(preferenceWrites(snapshot, "exec-approval-mode")).toEqual([
		{
			body: { value: "off" },
			method: "PUT",
			path: "/api/preferences/exec-approval-mode",
			status: 503,
		},
		{
			body: { value: "off" },
			method: "PUT",
			path: "/api/preferences/exec-approval-mode",
			status: 200,
		},
	]);
	await page.reload();
	await expect(scanner).toBeEnabled();
	await expect(scanner).not.toBeChecked();
	expect((await readProof(page)).preferences["exec-approval-mode"]).toBe("off");
	await scanner.click();
	await expect(
		page.getByText("Enabled. Saved for this node.", { exact: true })
	).toBeVisible();
	expect(
		preferenceWrites(await readProof(page), "exec-approval-mode").at(-1)
	).toEqual({
		body: { value: "enforce" },
		method: "PUT",
		path: "/api/preferences/exec-approval-mode",
		status: 200,
	});
	await page
		.getByText("Enabled. Saved for this node.", { exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: evidencePath("gateway-command-scanner-retry-saved"),
		animations: "disabled",
	});
	expect(errors).toEqual([]);
});

test("guardrails preferences and evaluator controls remain read-only without permission", async ({
	page,
}) => {
	await openGuardrails(page, "?permission=denied");
	await expect(
		// bc2b817e36 (Ryu Quiet) shortened the read-only banner to one line.
		page.getByText(
			/Read-only\. Ask a workspace admin for gateway\.configure\./u
		)
	).toBeVisible();
	await expect(
		page.locator("#exec-approval-enabled").locator("..").getByRole("switch")
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Catalog scanning agent" })
	).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Use default agent", exact: true })
	).toBeDisabled();
	await expect(
		page.getByRole("switch", { name: "Enable Coverage PII detector" })
	).toBeDisabled();
	expect(
		(await readProof(page)).requests.filter(
			(request) =>
				request.method === "PUT" &&
				[
					"/api/gateway/config",
					"/api/preferences/exec-approval-mode",
					"/api/preferences/security-scanner-agent",
				].some((endpoint) => request.path.endsWith(endpoint))
		)
	).toEqual([]);
	await page
		.locator("#exec-approval-enabled")
		.locator("..")
		.getByRole("switch")
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: evidencePath("gateway-preferences-permission-disabled"),
		animations: "disabled",
	});
});

test("failed scanner preference read stays disabled and recovers after reopening", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openGuardrails(page, "?failPreferenceRead=exec-approval-mode");
	await expect(
		page.getByText("Could not load command approval. Reopen settings to retry.")
	).toBeVisible();
	await expect(
		page.locator("#exec-approval-enabled").locator("..").getByRole("switch")
	).toBeDisabled();
	expect(preferenceWrites(await readProof(page), "exec-approval-mode")).toEqual(
		[]
	);
	await openGuardrails(page);
	await expect(
		page.locator("#exec-approval-enabled").locator("..").getByRole("switch")
	).toBeEnabled();
	await expect(
		page.locator("#exec-approval-enabled").locator("..").getByRole("switch")
	).toBeChecked();
	expect(errors).toEqual([]);
});

test("health audit agent selection and default reset persist, and failed reset can retry", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await openGuardrails(page, "?withAgent=true");
	const picker = page.getByRole("button", { name: "Catalog scanning agent" });
	const reset = page.getByRole("button", {
		name: "Use default agent",
		exact: true,
	});
	await expect(picker).toBeEnabled();
	await expect(reset).toBeDisabled();
	await picker.click();
	await page
		.getByRole("dialog", { name: "Choose provider and model" })
		.getByText("Coverage Agent", { exact: true })
		.click();
	await expect(picker).toContainText("Coverage Agent");
	await expect(
		page.getByText("Saved for this node.", { exact: true })
	).toBeVisible();
	expect(
		preferenceWrites(await readProof(page), "security-scanner-agent")
	).toEqual([
		{
			body: { value: "coverage-agent" },
			method: "PUT",
			path: "/api/preferences/security-scanner-agent",
			status: 200,
		},
	]);
	await page.reload();
	await expect(picker).toContainText("Coverage Agent");
	expect((await readProof(page)).preferences["security-scanner-agent"]).toBe(
		"coverage-agent"
	);
	await failPreferenceWrite(page);
	await reset.click();
	await expect(
		page.getByText("Could not save the audit agent. Try again.")
	).toBeVisible();
	await expect(picker).toContainText("Coverage Agent");
	expect((await readProof(page)).preferences["security-scanner-agent"]).toBe(
		"coverage-agent"
	);
	await reset.click();
	await expect(picker).toContainText("Use default agent");
	await expect(reset).toBeDisabled();
	expect(
		preferenceWrites(await readProof(page), "security-scanner-agent")
	).toEqual([
		{
			body: { value: "" },
			method: "PUT",
			path: "/api/preferences/security-scanner-agent",
			status: 503,
		},
		{
			body: { value: "" },
			method: "PUT",
			path: "/api/preferences/security-scanner-agent",
			status: 200,
		},
	]);
	await page.reload();
	await expect(picker).toContainText("Use default agent");
	expect((await readProof(page)).preferences["security-scanner-agent"]).toBe(
		""
	);
	await picker.scrollIntoViewIfNeeded();
	await page.screenshot({
		path: evidencePath("gateway-health-audit-agent-default-saved"),
		animations: "disabled",
	});
	expect(errors).toEqual([]);
});
