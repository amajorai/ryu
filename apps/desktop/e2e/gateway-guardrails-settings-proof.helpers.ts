// Shared helpers for the Gateway guardrails settings proofs
// (gateway-guardrails-settings-proof.spec.ts and gateway-guardrails-settings-controls-proof.spec.ts).
import path from "node:path";
import { expect } from "@playwright/test";
import { z } from "zod";
import type { GatewayFirewallOverlay } from "../src/lib/api/gateway.ts";

export interface CapturedRequest {
	body: unknown;
	method: string;
	path: string;
	status: number;
}

export interface GuardrailsProofSnapshot {
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

export const inspectorProofSchema = z.object({
	action: z.enum(["block", "warn_and_continue", "sanitize"]),
	enabled: z.boolean(),
	min_chars: z.number(),
	mode: z.enum(["injection", "dlp", "both"]),
	model: z.string(),
	timeout_ms: z.number(),
});
export const firewallProofSchema = z
	.object({ inspector: inspectorProofSchema.optional() })
	.catchall(z.json());
export const guardrailsPatchProofSchema = z.object({
	firewall: firewallProofSchema,
	firewall_agent_overlays: z
		.record(z.string(), z.record(z.string(), z.json()))
		.optional(),
	firewall_org_overlays: z
		.record(z.string(), z.record(z.string(), z.json()))
		.optional(),
});
export function evidencePath(name: string): string {
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

export async function openGuardrails(
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

export async function readProof(page: import("@playwright/test").Page) {
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

export async function choose(
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

export function preferenceWrites(
	snapshot: GuardrailsProofSnapshot,
	key: string
) {
	return snapshot.requests.filter(
		(request) =>
			request.method === "PUT" &&
			request.path.endsWith(`/api/preferences/${key}`)
	);
}

export async function failPreferenceWrite(
	page: import("@playwright/test").Page
) {
	await page.evaluate(() => {
		/* SAFETY: gateway-guardrails-proof.tsx installs __gatewayGuardrailsProof before this proof page is evaluated. */ (
			window as Window & {
				__gatewayGuardrailsProof: { failNextPreferenceWrite: boolean };
			}
		).__gatewayGuardrailsProof.failNextPreferenceWrite = true;
	});
}
