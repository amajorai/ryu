// The guardrail firewall rows hand the catalog whole messages: each alert tier
// option is one literal ("Silent: no notification (default)") and the tier,
// action and field names are resolved before they fill "Inherit ({label})" or
// "Lock {fieldLabel} field". The DOM localizer is off, so the components
// themselves must translate; no English word may survive in a translated name.

import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { I18nProvider } = await import("@ryu/i18n/react");
const { FirewallCard } = await import("./firewall-cards.tsx");
const { guardrailAlertTierOptions } = await import("./copy.ts");
type Ctx = import("./types.ts").GuardrailScopeCtx;

const DE: Record<string, string> = {
	Alerts: "Warnungen",
	Enabled: "Aktiviert",
	"Lock {fieldLabel} field": "Feld {fieldLabel} sperren",
	Policy: "Richtlinie",
	"Scan inbound": "Eingehend prüfen",
	"Silent: no notification (default)":
		"Stumm: keine Benachrichtigung (Standard)",
	"Warn and continue: log only": "Warnen und fortfahren: nur protokollieren",
};

const JA: Record<string, string> = {
	"Inherit ({label})": "継承 ({label})",
	Off: "オフ",
	On: "オン",
	Silent: "サイレント",
	"Warn and continue": "警告して続行",
};

const AR: Record<string, string> = {
	"Inherit ({label})": "وراثة ({label})",
	On: "تشغيل",
	Silent: "صامت",
	"Warn and continue": "تحذير ومتابعة",
};

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
	registerLiteralCatalogLoader(null);
	if (mounted) {
		const { container, root } = mounted;
		await act(async () => {
			root.unmount();
		});
		container.remove();
		mounted = undefined;
	}
});
afterAll(async () => {
	if (ownsDom) {
		await GlobalRegistrator.unregister();
	}
});

function ctxFor(overrides: Partial<Ctx>): Ctx {
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

async function renderCard(locale: string, ctx: Ctx): Promise<HTMLElement> {
	registerLiteralCatalogLoader((requested) => {
		if (requested.startsWith("de")) {
			return DE;
		}
		if (requested.startsWith("ar")) {
			return AR;
		}
		return requested.startsWith("ja") ? JA : {};
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<FirewallCard caption="Node baseline" ctx={ctx} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

function ariaLabels(container: HTMLElement): string[] {
	return [...container.querySelectorAll("[aria-label]")].map(
		(element) => element.getAttribute("aria-label") ?? ""
	);
}

test("every alert tier option is one whole literal message", () => {
	const seen: string[] = [];
	const options = guardrailAlertTierOptions((source) => {
		seen.push(source);
		return `«${source}»`;
	});
	expect(options.map((option) => option.value)).toEqual([
		"silent",
		"warn",
		"fanout",
		"email",
	]);
	expect(options[0]?.label).toBe("«Silent: no notification (default)»");
	expect(seen).toHaveLength(4);
	expect(seen.every((source) => source.includes(": "))).toBe(true);
});

test("German shows the alert tier and action as whole translated options", async () => {
	const container = await renderCard("de", ctxFor({}));
	const text = container.textContent ?? "";
	expect(text).toContain("Stumm: keine Benachrichtigung (Standard)");
	expect(text).toContain("Warnen und fortfahren: nur protokollieren");
	expect(text).not.toContain("Silent: ");
	expect(text).not.toContain("No notification");
});

test("German lock toggles name the translated field", async () => {
	const labels = ariaLabels(await renderCard("de", ctxFor({})));
	expect(labels).toContain("Feld Eingehend prüfen sperren");
	expect(labels).toContain("Feld Warnungen sperren");
	expect(labels).toContain("Feld Richtlinie sperren");
	expect(labels.some((label) => label.includes("Scan inbound"))).toBe(false);
	expect(labels).toContain("Eingehend prüfen");
});

test("Japanese Inherit options name the translated inherited value", async () => {
	const container = await renderCard(
		"ja",
		ctxFor({ isOverlay: true, overlayId: "org", scope: "org" })
	);
	const text = container.textContent ?? "";
	expect(text).toContain("継承 (警告して続行)");
	expect(text).toContain("継承 (サイレント)");
	expect(text).toContain("継承 (オン)");
	expect(text).not.toContain("Warn and continue");
	expect(text).not.toContain("Silent");
});

test("Arabic Inherit options carry no English inherited value", async () => {
	const container = await renderCard(
		"ar",
		ctxFor({ isOverlay: true, overlayId: "org", scope: "org" })
	);
	const text = container.textContent ?? "";
	expect(text).toContain("وراثة (تحذير ومتابعة)");
	expect(text).toContain("وراثة (صامت)");
	expect(text).toContain("وراثة (تشغيل)");
	expect(text).not.toContain("Warn and continue");
	expect(text).not.toContain("Inherit");
});
