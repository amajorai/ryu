// The agent-audit result badge says whether the agent covered all of the
// evidence. "Complete" alone reads as a finished state (完了, Abgeschlossen,
// مكتمل) once translated, so the badge names the audit's coverage instead.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const registeredDom = globalThis.document === undefined;
if (registeredDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(async () => {
	if (registeredDom) {
		await GlobalRegistrator.unregister();
	}
});

const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { AgentAuditPanel } = await import("./agent-audit-panel.tsx");

const STUBS: Record<string, Record<string, string>> = {
	ar: {
		Complete: "مكتمل",
		"Full audit": "تدقيق كامل",
		Partial: "جزئي",
		"Partial audit": "تدقيق جزئي",
	},
	de: {
		Complete: "Abgeschlossen",
		"Full audit": "Vollständiges Audit",
		Partial: "Teilweise",
		"Partial audit": "Teilaudit",
	},
	ja: {
		Complete: "完了",
		"Full audit": "完全な監査",
		Partial: "一部完了",
		"Partial audit": "部分的な監査",
		"{score}/100 advisory score": "参考スコア {score}/100",
	},
};

const roots: Root[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function auditBadge(
	locale: string,
	status: "complete" | "partial",
	selector = '[data-testid="catalog-scan-result"] [data-slot="badge"]',
	score: number | null = null
): Promise<string> {
	registerLiteralCatalogLoader((requested) => STUBS[requested] ?? {});
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<AgentAuditPanel
					runAudit={() =>
						Promise.resolve({
							agentId: "default",
							assessment:
								score === null
									? null
									: {
											confidence: "high",
											evidence: [],
											limitations: [],
											recommendations: [],
											score,
											summary: "Fine.",
										},
							report: "Done.",
							status,
						})
					}
				/>
			</I18nProvider>
		);
	});
	const button = host.querySelector<HTMLButtonElement>(
		'[data-testid="catalog-scan-button"]'
	);
	await act(async () => {
		button?.click();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const badge = host.querySelector(selector);
	return badge?.textContent ?? "";
}

describe("AgentAuditPanel coverage badge", () => {
	test.each([
		["ja", "complete", "完全な監査"],
		["ja", "partial", "部分的な監査"],
		["de", "complete", "Vollständiges Audit"],
		["de", "partial", "Teilaudit"],
		["ar", "complete", "تدقيق كامل"],
		["ar", "partial", "تدقيق جزئي"],
	] as const)("%s names a %s audit by its coverage", async (locale, status, expected) => {
		expect(await auditBadge(locale, status)).toBe(expected);
	});

	test("English names the coverage, not a finished state", async () => {
		expect(await auditBadge("en", "complete")).toBe("Full audit");
		expect(await auditBadge("en", "partial")).toBe("Partial audit");
	});
});

test("the advisory score is one translated sentence", async () => {
	expect(
		await auditBadge(
			"ja",
			"complete",
			'[data-testid="catalog-scan-result"] span.font-medium',
			82
		)
	).toBe("参考スコア 82/100");
});
