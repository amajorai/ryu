// Traffic counts and the status line in the reader's language: compact
// numbers use the locale's own notation, and every counted phrase is one whole
// message so a translation can reorder or inflect it.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { formatMessage } from "@ryu/i18n/lite";
import { I18nProvider, type LiteralMessage } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { formatCount } = await import("./format-count.ts");
const { FeedStatus } = await import("./gateway-canvas-controls.tsx");
const { createCanvasLiveStore } = await import("./live-store.ts");
const { countersPhrase, nodeAccessibleName } = await import("./nodes.tsx");

const english: LiteralMessage = (source, values = {}) =>
	formatMessage(source, values, "en");

const DE: Record<string, string> = {
	"{blocked} blocked": "{blocked} blockiert",
	"{count, plural, one {{formatted} request} other {{formatted} requests}}":
		"{count, plural, one {{formatted} Anfrage} other {{formatted} Anfragen}}",
	"{rate}/s": "{rate}/s",
	Live: "Live",
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

async function statusLine(locale: string): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const store = createCanvasLiveStore({ schedule: (flush) => flush() });
	store.replaceCounters({
		gateway: { blocked: 0, requests: 1_234_567 },
		"stage:rate_limit": { blocked: 4, requests: 1_234_567 },
	});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<FeedStatus feed={{ status: "aggregated" }} store={store} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

describe("formatCount", () => {
	test("keeps the English short form byte for byte", () => {
		expect(formatCount(980, "en")).toBe("980");
		expect(formatCount(1200, "en")).toBe("1.2k");
		expect(formatCount(34_000, "en")).toBe("34k");
		expect(formatCount(1_100_000, "en")).toBe("1.1M");
	});

	test("uses the locale's compact notation elsewhere", () => {
		const german = formatCount(1_200_000, "de");
		expect(german).toBe(
			new Intl.NumberFormat("de", {
				maximumFractionDigits: 1,
				notation: "compact",
			}).format(1_200_000)
		);
		expect(german).toContain("1,2");
		const arabic = formatCount(1_200_000, "ar");
		expect(arabic).not.toContain("M");
		expect(arabic).toBe(
			new Intl.NumberFormat("ar", {
				maximumFractionDigits: 1,
				notation: "compact",
			}).format(1_200_000)
		);
	});
});

describe("counted phrases", () => {
	test("read as whole English messages with plural agreement", () => {
		expect(countersPhrase(english, { blocked: 0, requests: 1 })).toBe(
			"1 request"
		);
		expect(
			countersPhrase(english, { blocked: 3, p50Ms: 39.6, requests: 1200 })
		).toBe("1.2k requests, 3 blocked, median 40 ms");
	});

	test("route every word of a node's accessible name through the translator", () => {
		const marked: LiteralMessage = () => "«»";
		const name = nodeAccessibleName(
			marked,
			{
				health: "degraded",
				id: "stage:platform_floor",
				kind: "stage",
				label: "Platform floor",
				locked: true,
			},
			{ blocked: 0, requests: 2 }
		);
		// Kind, lock, health and counts: only the node's own label is not a message.
		expect(name).toBe("Platform floor, «», «», «», «»");
	});
});

describe("FeedStatus", () => {
	test("German status line uses German words and digits", async () => {
		const line = await statusLine("de");
		expect(line).toContain("Anfragen");
		expect(line).toContain("4 blockiert");
		expect(line).toContain("1,2");
		expect(line).not.toContain("requests");
	});

	test("Arabic status line formats the count in Arabic", async () => {
		const line = await statusLine("ar");
		expect(line).toContain(formatCount(1_234_567, "ar"));
		expect(line).not.toContain("1.2M");
	});
});
