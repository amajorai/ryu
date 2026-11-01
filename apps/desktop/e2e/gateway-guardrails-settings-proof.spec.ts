import { expect, test } from "@playwright/test";
import {
	choose,
	evidencePath,
	guardrailsPatchProofSchema,
	openGuardrails,
	readProof,
} from "./gateway-guardrails-settings-proof.helpers.ts";

test.describe.configure({ timeout: 90_000 });

test("edits node filters and custom patterns, saves the complete firewall slice, and reloads it", async ({
	page,
}) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));
	await openGuardrails(page);

	const enabled = page.getByRole("switch", { name: "Enabled" });
	const scanInbound = page.getByRole("switch", { name: "Scan inbound" });
	const scanOutbound = page.getByRole("switch", { name: "Scan outbound" });
	const logDetections = page.getByRole("switch", { name: "Log detections" });
	const redactPii = page.getByRole("switch", { name: "Redact PII" });
	const redactSecrets = page.getByRole("switch", { name: "Redact secrets" });
	await expect(enabled).toBeChecked();
	await expect(scanInbound).toBeChecked();
	await expect(scanOutbound).toBeChecked();
	await expect(logDetections).toBeChecked();
	await expect(redactPii).toBeChecked();
	await expect(redactSecrets).not.toBeChecked();
	await enabled.click();
	await scanInbound.click();
	await scanOutbound.click();
	await logDetections.click();
	await redactPii.click();
	await redactSecrets.click();
	await choose(page, "Policy", "Sanitize");
	await choose(page, "Alerts", "Fanout");
	await page.getByRole("button", { name: "Lock Policy field" }).click();
	await page.getByRole("button", { name: "Add pattern" }).click();
	await page
		.getByRole("textbox", { name: "Pattern name" })
		.fill("internal_ref");
	await page
		.getByRole("textbox", { name: "Pattern regex" })
		.fill("REF-[0-9]{6}");
	await choose(page, "Pattern kind", "Prompt injection");
	await expect(
		page.getByRole("combobox", { name: "Pattern kind" })
	).toContainText("Prompt injection");
	await page.getByRole("button", { name: "Add pattern" }).click();
	await expect(page.getByRole("textbox", { name: "Pattern name" })).toHaveCount(
		2
	);
	await expect(
		page.getByRole("button", { name: "Remove pattern" })
	).toHaveCount(2);
	await page.getByRole("button", { name: "Remove pattern" }).last().click();
	await expect(page.getByRole("textbox", { name: "Pattern name" })).toHaveCount(
		1
	);
	await expect(
		page.getByText(
			/Redaction toggles apply only when the firewall policy is set to Sanitize/
		)
	).toHaveCount(0);
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByRole("status")).toHaveText("Saved.");

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.path.endsWith("/api/gateway/config") && request.method === "PUT"
	);
	expect(put, "Save sends a Gateway config update").toBeDefined();
	const payload = guardrailsPatchProofSchema.parse(put?.body);
	expect(payload.firewall).toMatchObject({
		alert: "fanout",
		custom_patterns: [
			{ kind: "prompt_injection", name: "internal_ref", regex: "REF-[0-9]{6}" },
		],
		enabled: false,
		locked_fields: ["scan_inbound", "policy"],
		policy: "sanitize",
		log_detections: false,
		redact_pii: false,
		redact_secrets: true,
		scan_inbound: false,
		scan_outbound: false,
	});
	expect(payload.firewall.inspector).toMatchObject({
		action: "block",
		enabled: false,
		min_chars: 40,
		mode: "both",
		model: "gemma-3-270m-it",
		timeout_ms: 1500,
	});
	expect(payload.firewall.alert).toBe("fanout");
	expect(payload.firewall_org_overlays).toEqual({
		"org-kept": { policy: "sanitize", scan_inbound: true },
	});
	expect(payload.firewall_agent_overlays).toEqual({
		"agent-kept": { policy: "block", scan_outbound: true },
	});
	await page
		.getByRole("heading", { name: "Guardrails", exact: true })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-node-saved"),
	});

	await page.reload();
	await expect(page.getByRole("switch", { name: "Enabled" })).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Scan inbound" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Scan outbound" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Log detections" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Redact PII" })
	).not.toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Redact secrets" })
	).toBeChecked();
	await expect(
		page.getByRole("button", { name: "Unlock Policy field" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("textbox", { name: "Pattern name" })).toHaveValue(
		"internal_ref"
	);
	await expect(
		page.getByRole("textbox", { name: "Pattern regex" })
	).toHaveValue("REF-[0-9]{6}");
	await expect(
		page.getByRole("combobox", { name: "Pattern kind" })
	).toContainText("Prompt injection");
	await expect(page.getByRole("combobox", { name: "Policy" })).toContainText(
		"Sanitize"
	);
	await expect(page.getByRole("combobox", { name: "Alerts" })).toContainText(
		"Fanout"
	);
	expect(pageErrors).toEqual([]);
});

test("node locks survive save and make narrower scope fields read-only", async ({
	page,
}) => {
	await openGuardrails(page);

	const enabledLock = page.getByRole("button", { name: "Lock Enabled field" });
	await enabledLock.focus();
	await expect(
		page.getByText("Lock so narrower scopes cannot loosen this field.", {
			exact: true,
		})
	).toBeVisible();
	await enabledLock.click();
	const enabledUnlock = page.getByRole("button", {
		name: "Unlock Enabled field",
	});
	await expect(enabledUnlock).toHaveAttribute("aria-pressed", "true");
	await enabledUnlock.focus();
	await expect(
		page.getByText(
			"Locked. Narrower scopes (org, agent) cannot loosen this field.",
			{ exact: true }
		)
	).toBeVisible();

	await choose(page, "Policy", "Block");
	await page.getByRole("button", { name: "Lock Policy field" }).click();
	await choose(page, "Alerts", "Fanout");
	await page.getByRole("button", { name: "Lock Alerts field" }).click();
	await page.getByRole("button", { name: "Lock LLM inspector field" }).click();
	await expect(
		page.getByRole("button", { name: "Unlock LLM inspector field" })
	).toHaveAttribute("aria-pressed", "true");
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByRole("status")).toHaveText("Saved.");

	const saved = await readProof(page);
	const write = saved.requests.find(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(write?.body).toMatchObject({
		firewall: {
			alert: "fanout",
			locked_fields: [
				"scan_inbound",
				"enabled",
				"policy",
				"alert",
				"inspector",
			],
			policy: "block",
		},
	});
	await page
		.getByRole("button", { name: "Unlock Alerts field" })
		.scrollIntoViewIfNeeded();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-node-scope-locks"),
	});

	await page.reload();
	await expect(
		page.getByRole("button", { name: "Unlock Enabled field" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unlock Policy field" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unlock Alerts field" })
	).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("button", { name: "Unlock LLM inspector field" })
	).toHaveAttribute("aria-pressed", "true");

	await choose(page, "Scope", "Org overlay");
	await page.getByLabel("Org id").fill("guardrails-lock-proof-org");
	await expect(page.getByRole("combobox", { name: "Enabled" })).toHaveCount(0);
	await expect(page.getByRole("switch", { name: "Enabled" })).toHaveCount(0);
	await expect(page.getByRole("combobox", { name: "Policy" })).toHaveCount(0);
	await expect(page.getByRole("combobox", { name: "Alerts" })).toHaveCount(0);
	await expect(page.getByText(/Inspector locked \(/)).toBeVisible();
	await expect(
		page.getByRole("switch", { name: "Enable LLM inspector" })
	).toHaveCount(0);
	await expect(page.getByText("On", { exact: true })).toHaveCount(2);
	await expect(page.getByText("Block", { exact: true })).toBeVisible();
	await expect(page.getByText("Fanout", { exact: true })).toBeVisible();
	await page.getByText("Block", { exact: true }).hover();
	await expect(
		page.getByText(
			"Locked by a broader scope. Change it there to unlock this field.",
			{ exact: true }
		)
	).toBeVisible();
	await page.getByText("Fanout", { exact: true }).hover();
	await expect(
		page
			.getByText(
				"Locked by a broader scope. Change it there to unlock this field.",
				{ exact: true }
			)
			.last()
	).toBeVisible();
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-org-scope-locked-readonly"),
	});
	const beforeUnlock = await readProof(page);
	expect(
		beforeUnlock.requests.some(
			(request) =>
				request.method === "PUT" && request.path.endsWith("/api/gateway/config")
		)
	).toBe(false);

	await choose(page, "Scope", "Node (baseline)");
	await page.getByRole("button", { name: "Unlock Enabled field" }).click();
	await page.getByRole("button", { name: "Unlock Policy field" }).click();
	await page.getByRole("button", { name: "Unlock Alerts field" }).click();
	await page
		.getByRole("button", { name: "Unlock LLM inspector field" })
		.click();
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByRole("status")).toHaveText("Saved.");
	const unlocked = await readProof(page);
	const unlockWrite = unlocked.requests.find(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(unlockWrite?.body).toMatchObject({
		firewall: {
			alert: "fanout",
			locked_fields: ["scan_inbound"],
			policy: "block",
		},
	});
	await page.reload();
	expect((await readProof(page)).config.firewall.locked_fields).toEqual([
		"scan_inbound",
	]);
	await expect(
		page.getByRole("button", { name: "Lock Enabled field" })
	).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.getByRole("button", { name: "Lock Policy field" })
	).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.getByRole("button", { name: "Lock Alerts field" })
	).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.getByRole("button", { name: "Lock LLM inspector field" })
	).toHaveAttribute("aria-pressed", "false");
});

test("invalid regex is reported by the Gateway, kept in the draft, then saves after correction", async ({
	page,
}) => {
	await openGuardrails(page);
	await page.getByRole("button", { name: "Add pattern" }).click();
	await page.getByRole("textbox", { name: "Pattern name" }).fill("broken_ref");
	const regex = page.getByRole("textbox", { name: "Pattern regex" });
	await regex.fill("[");
	await expect(regex).toHaveAttribute("aria-invalid", "true");
	await expect(
		page.getByText(/Invalid regex\. Checked with the browser engine/)
	).toBeVisible();
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByRole("alert")).toHaveText(
		"invalid custom pattern: invalid regex"
	);
	await expect(regex).toHaveValue("[");
	await expect(page.getByText("Saved.", { exact: true })).toHaveCount(0);
	const rejected = await readProof(page);
	expect(rejected.config.firewall.custom_patterns).toEqual([]);
	const rejectedWrite = rejected.requests.find(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(rejectedWrite?.body).toMatchObject({
		firewall: {
			custom_patterns: [{ kind: "pii", name: "broken_ref", regex: "[" }],
		},
	});
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-invalid-regex"),
	});

	await regex.fill("REF-[0-9]+");
	await expect(regex).toHaveAttribute("aria-invalid", "false");
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
	await expect
		.poll(async () => (await readProof(page)).config.firewall.custom_patterns)
		.toEqual([{ kind: "pii", name: "broken_ref", regex: "REF-[0-9]+" }]);
});

test("a rejected write preserves the user's draft and a retry persists it", async ({
	page,
}) => {
	await openGuardrails(page);
	const enabled = page.getByRole("switch", { name: "Enabled" });
	await enabled.click();
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
	await expect(enabled).not.toBeChecked();
	await expect(save).toBeEnabled();
	await expect(page.getByText("Saved.", { exact: true })).toHaveCount(0);
	await page.screenshot({
		animations: "disabled",
		fullPage: true,
		path: evidencePath("gateway-guardrails-write-error"),
	});

	await save.click();
	await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
	const saved = await readProof(page);
	const writes = saved.requests.filter(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	expect(writes).toHaveLength(2);
	expect(saved.config.firewall.enabled).toBe(false);
});

test("an org overlay writes tri-state values, leaves locked fields read-only, and preserves sibling overlays", async ({
	page,
}) => {
	await openGuardrails(page);
	await choose(page, "Scope", "Org overlay");
	await expect(page.getByRole("combobox", { name: "Enabled" })).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save guardrails" })
	).toBeDisabled();
	await page.getByLabel("Org id").fill("proof-org");
	await expect(
		page.getByText(/A field the node locked is read-only here/)
	).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Scan inbound" })
	).toHaveCount(0);
	await expect(page.getByRole("switch", { name: "Scan inbound" })).toHaveCount(
		0
	);
	await choose(page, "Enabled", "Off");
	await choose(page, "Scan outbound", "Off");
	await choose(page, "Log detections", "Off");
	await choose(page, "Log detections", "Inherit (On)");
	await choose(page, "Redact PII", "Off");
	await choose(page, "Redact secrets", "On");
	await choose(page, "Policy", "Block");
	await choose(page, "Alerts", "Fanout");
	await page.getByRole("button", { name: "Add pattern" }).click();
	await page.getByRole("textbox", { name: "Pattern name" }).fill("org_ref");
	await page
		.getByRole("textbox", { name: "Pattern regex" })
		.fill("ORG-[A-Z]{4}");
	await choose(page, "Pattern kind", "Secret");
	await page.getByRole("switch", { name: "Override inspector" }).click();
	await page.getByRole("switch", { name: "Enable LLM inspector" }).click();
	await page.getByRole("button", { name: "Save guardrails" }).click();
	await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

	const saved = await readProof(page);
	const put = saved.requests.find(
		(request) =>
			request.method === "PUT" && request.path.endsWith("/api/gateway/config")
	);
	const payload = guardrailsPatchProofSchema.parse(put?.body);
	expect(payload.firewall).toMatchObject({
		enabled: true,
		locked_fields: ["scan_inbound"],
		scan_inbound: true,
		scan_outbound: true,
	});
	expect(payload.firewall_org_overlays).toEqual({
		"org-kept": { policy: "sanitize", scan_inbound: true },
		"proof-org": {
			alert: "fanout",
			custom_patterns: [
				{ kind: "secret", name: "org_ref", regex: "ORG-[A-Z]{4}" },
			],
			enabled: false,
			inspector: {
				action: "block",
				enabled: true,
				min_chars: 40,
				mode: "both",
				model: "gemma-3-270m-it",
				timeout_ms: 1500,
			},
			log_detections: null,
			policy: "block",
			redact_pii: false,
			redact_secrets: true,
			scan_outbound: false,
		},
	});
	expect(payload.firewall_agent_overlays).toEqual({
		"agent-kept": { policy: "block", scan_outbound: true },
	});

	await page.reload();
	await choose(page, "Scope", "Org overlay");
	await page.getByLabel("Org id").fill("proof-org");
	await expect(page.getByRole("combobox", { name: "Enabled" })).toContainText(
		"Off"
	);
	await expect(
		page.getByRole("combobox", { name: "Log detections" })
	).toContainText("Inherit (On)");
	await expect(
		page.getByRole("switch", { name: "Override inspector" })
	).toBeChecked();
	await expect(
		page.getByRole("switch", { name: "Enable LLM inspector" })
	).toBeChecked();
	await expect(page.getByRole("combobox", { name: "Alerts" })).toContainText(
		"Fanout"
	);
	await expect(page.getByRole("combobox", { name: "Policy" })).toContainText(
		"Block"
	);
});
