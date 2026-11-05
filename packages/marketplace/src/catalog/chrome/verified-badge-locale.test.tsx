// The publisher check under a Japanese UI: the trigger's accessible name must
// come from the catalog, not from @ryuhq/protocol's English labels.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { LiteralMessage } from "@ryu/i18n/react";
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
const { formatMessage } = await import("@ryu/i18n");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { default: VerifiedBadge } = await import("./verified-badge.tsx");
const { publisherTrustCopy } = await import("./verified-badge-copy.ts");
const { publisherTrustLabel, publisherTrustTooltip } = await import(
	"@ryuhq/protocol/publisher-trust"
);

const JA: Record<string, string> = {
	"Verified business": "認証済みビジネス",
	"Verified paid organization": "認証済みの有料組織",
	"Verified organization": "認証済みの組織",
};

const roots: Root[] = [];

async function renderBadge(
	props: Parameters<typeof VerifiedBadge>[0]
): Promise<string[]> {
	registerLiteralCatalogLoader(() => JA);
	const mount = document.createElement("div");
	document.body.append(mount);
	const root = createRoot(mount);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale="ja"
				initialPackId={null}
			>
				<VerifiedBadge {...props} />
			</I18nProvider>
		);
	});
	return [...mount.querySelectorAll("[aria-label]")].map(
		(node) => node.getAttribute("aria-label") ?? ""
	);
}

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await act(async () => {
			root.unmount();
		});
	}
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

describe("VerifiedBadge under ja", () => {
	test("a blue publisher's accessible name is the Japanese label", async () => {
		const labels = await renderBadge({ publisherTrust: "blue" });
		expect(labels.length).toBeGreaterThan(0);
		for (const label of labels) {
			expect(label).toBe("認証済みの有料組織");
			expect(label).not.toMatch(/[A-Za-z]/);
		}
	});

	test("a gold publisher's accessible name is the Japanese label", async () => {
		const labels = await renderBadge({ publisherTrust: "gold" });
		expect(labels).toContain("認証済みビジネス");
		expect(labels.join(" ")).not.toContain("Verified");
	});

	test("the legacy org flag without a tier translates too", async () => {
		const labels = await renderBadge({ orgVerified: true });
		expect(labels).toContain("認証済みの組織");
	});
});

describe("publisherTrustCopy", () => {
	test("each level is a distinct label and tooltip, all through tl()", () => {
		const seen: string[] = [];
		const tl: LiteralMessage = (source, values) => {
			seen.push(source);
			return formatMessage(source, values);
		};
		const levels = ["gold", "blue", "dotted"] as const;
		const copies = levels.map((level) => publisherTrustCopy(tl, level));
		expect(new Set(copies.map((copy) => copy.label)).size).toBe(3);
		expect(new Set(copies.map((copy) => copy.tooltip)).size).toBe(3);
		expect(seen).toHaveLength(6);
		expect(copies[0]).toEqual({
			label: "Verified business",
			tooltip:
				"Ryu staff verified this Business organization, its Stripe identity, and its domain.",
		});
	});

	test("English copy is unchanged from the protocol labels", () => {
		const english: LiteralMessage = (source, values) =>
			formatMessage(source, values);
		for (const level of ["gold", "blue", "dotted"] as const) {
			expect(publisherTrustCopy(english, level)).toEqual({
				label: publisherTrustLabel(level),
				tooltip: publisherTrustTooltip(level),
			});
		}
	});
});
