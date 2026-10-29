import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FirewallCard } from "./firewall-cards.tsx";
import { overlayBoolPatch } from "./firewall-rows.tsx";
import type { GuardrailScopeCtx } from "./types.ts";

function ctxFor(overrides: Partial<GuardrailScopeCtx>): GuardrailScopeCtx {
	return {
		broaderLocked: new Set(),
		disabled: false,
		isOverlay: false,
		lockedHere: new Set(),
		node: {
			alert: "silent",
			enabled: true,
			log_detections: false,
			policy: "warn_and_continue",
			redact_pii: false,
			redact_secrets: false,
			scan_inbound: true,
			scan_outbound: false,
		},
		overlay: {},
		overlayId: "",
		overlayReady: true,
		scope: "node",
		setNodeField: () => undefined,
		setOverlayField: () => undefined,
		toggleLock: () => undefined,
		...overrides,
	};
}

describe("overlayBoolPatch", () => {
	test("an add-only overlay never emits false", () => {
		expect(overlayBoolPatch("redact_pii", false, true)).toEqual({
			redact_pii: null,
		});
		expect(overlayBoolPatch("redact_pii", true, true)).toEqual({
			redact_pii: true,
		});
		expect(overlayBoolPatch("redact_pii", null, true)).toEqual({
			redact_pii: null,
		});
	});

	test("an ordinary overlay keeps Off as an explicit override", () => {
		expect(overlayBoolPatch("scan_inbound", false)).toEqual({
			scan_inbound: false,
		});
	});
});

describe("FirewallCard", () => {
	test("the base scope offers lock toggles and the alert row", () => {
		const html = renderToStaticMarkup(
			<FirewallCard caption="Node baseline" ctx={ctxFor({})} />
		);
		expect(html).toContain("Lock Enabled field");
		expect(html).toContain("Alerts");
		expect(html).toContain("Custom patterns");
	});

	test("a policy editor hides the alert row and never names the unknown base", () => {
		const html = renderToStaticMarkup(
			<FirewallCard
				caption="Policy"
				ctx={ctxFor({
					addOnly: true,
					inheritedUnknown: true,
					isOverlay: true,
					overlay: { redact_pii: true },
					scope: "policy",
				})}
				showAlert={false}
			/>
		);
		expect(html).not.toContain("Alerts");
		expect(html).not.toContain("Lock Enabled field");
		expect(html).not.toContain("Inherit (");
	});

	test("an overlay names the inherited base value when it is known", () => {
		const html = renderToStaticMarkup(
			<FirewallCard
				caption="Org overlay"
				ctx={ctxFor({ isOverlay: true, overlayId: "org", scope: "org" })}
			/>
		);
		expect(html).toContain("Inherit (On)");
	});

	test("a field locked by a broader scope renders read-only", () => {
		const html = renderToStaticMarkup(
			<FirewallCard
				caption="Org overlay"
				ctx={ctxFor({
					broaderLocked: new Set(["enabled"]),
					isOverlay: true,
					overlayId: "org",
					scope: "org",
				})}
			/>
		);
		expect(html).not.toContain('id="fw-enabled"');
	});
});
