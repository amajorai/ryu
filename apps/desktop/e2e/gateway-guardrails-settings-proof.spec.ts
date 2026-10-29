import path from "node:path";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import type { GatewayFirewallOverlay } from "../src/lib/api/gateway.ts";

interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

interface GuardrailsProofSnapshot {
	config: {
		firewall: {
			alert?: string;
			custom_patterns?: { kind: string; name: string; regex: string }[];
			enabled: boolean;
			evaluators?: {
				enabled: boolean;
				id: string;
				inlineAction?: string;
				locked?: boolean;
			}[];
			inspector?: {
				action: string;
				enabled: boolean;
				min_chars: number;
				mode: string;
				model: string;
				timeout_ms: number;
			};
			locked_fields?: string[];
			policy: string;
			redact_pii: boolean;
			redact_secrets: boolean;
			scan_inbound: boolean;
			scan_outbound: boolean;
		};
		firewall_agent_overlays: Record<string, GatewayFirewallOverlay>;
		firewall_org_overlays: Record<string, GatewayFirewallOverlay>;
	};
	preferences: Record<string, string>;
	requests: CapturedRequest[];
}

const inspectorProofSchema = z.object({
	action: z.enum(["block", "warn_and_continue", "sanitize"]),
	enabled: z.boolean(),
	min_chars: z.number(),
	mode: z.enum(["injection", "dlp", "both"]),
	model: z.string(),
	timeout_ms: z.number(),
});
const firewallProofSchema = z
	.object({ inspector: inspectorProofSchema.optional() })
	.catchall(z.json());
const guardrailsPatchProofSchema = z.object({
	firewall: firewallProofSchema,
	firewall_agent_overlays: z
		.record(z.string(), z.record(z.string(), z.json()))
		.optional(),
	firewall_org_overlays: z
		.record(z.string(), z.record(z.string(), z.json()))
		.optional(),
});
function evidencePath(name: string): string {
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

async function openGuardrails(
	page: import("@playwright/test").Page,
	query = ""
): Promise<void> {
	await page.goto(`/gateway-guardrails-settings-proof.html${query}`, {
		waitUntil: "domcontentloaded",
	});
	await expect(
		page.getByRole("heading", { name: "Safety filters" })
	).toBeVisible();
}

async function readProof(page: import("@playwright/test").Page) {
	await page.waitForFunction(() => {
		const proof = (
			window as Window & {
				__gatewayGuardrailsProof?: {
					snapshot?: () => GuardrailsProofSnapshot;
				};
			}
		).__gatewayGuardrailsProof;
		return typeof proof?.snapshot === "function";
	});
	return page.evaluate(() => {
		const proof =
			/* SAFETY: gateway-guardrails-proof.tsx installs __gatewayGuardrailsProof before this proof page is evaluated. */ (
				window as Window & {
					__gatewayGuardrailsProof: {
						snapshot: () => GuardrailsProofSnapshot;
					};
				}
			).__gatewayGuardrailsProof;
		return proof.snapshot();
	});
}

async function choose(
	page: import("@playwright/test").Page,
	label: string,
	option: string
): Promise<void> {
	const trigger = page.getByRole("combobox", { name: label });
	await trigger.click();
	const listbox = page.getByRole("listbox").last();
	await listbox
		.getByRole("option")
		.filter({ hasText: option })
		.click({ timeout: 5000 });
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(listbox).toBeHidden();
}

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
		page.getByText(/You do not have the gateway\.configure permission/)
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

function preferenceWrites(snapshot: GuardrailsProofSnapshot, key: string) {
	return snapshot.requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path.endsWith(`/api/preferences/${key}`)
	);
}

async function failPreferenceWrite(page: import("@playwright/test").Page) {
	await page.evaluate(() => {
		/* SAFETY: gateway-guardrails-proof.tsx installs __gatewayGuardrailsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayGuardrailsProof: { failNextPreferenceWrite: boolean };
			}
		).__gatewayGuardrailsProof.failNextPreferenceWrite = true;
	});
}

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
		page.getByText(/You do not have the gateway\.configure permission/)
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
