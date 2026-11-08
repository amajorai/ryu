// The line view's station status ("Idle", "Cooking, longer than usual",
// "Burnt order") is catalog copy, so a Japanese reader sees the ja values.
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { KitchenLine } = await import("./kitchen-overlay.tsx");
type Service = Parameters<typeof KitchenLine>[0]["service"];
type Station = Service["stations"][number];

const JA: Record<string, string> = {
	"Burnt order": "焦げた注文",
	"Cooking, longer than usual": "調理中、いつもより長くかかっています",
	Idle: "待機中",
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

function station(
	id: string,
	index: number,
	state: Pick<Station, "burnt" | "runStartedAt" | "working">
): Station {
	return {
		agent: {
			avatarUrl: null,
			description: "",
			id,
			name: id,
		} as Station["agent"],
		column: index,
		index,
		kind: "stove",
		orders: [],
		row: 0,
		typicalFromHistory: false,
		typicalMs: 60_000,
		x: 0,
		z: 0,
		...state,
	};
}

const SERVICE = {
	dishes: [],
	dishOverflow: 0,
	rail: [],
	stations: [
		station("idle", 0, { burnt: false, runStartedAt: null, working: false }),
		// Started an hour ago against a one-minute typical run: over time.
		station("slow", 1, {
			burnt: false,
			runStartedAt: Date.now() - 3_600_000,
			working: true,
		}),
		station("burnt", 2, { burnt: true, runStartedAt: null, working: false }),
	],
} as unknown as Service;

async function renderLine(locale: string) {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<KitchenLine
					onSelectChef={() => undefined}
					onServe={() => undefined}
					service={SERVICE}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

test("Japanese shows the catalog value for each station status", async () => {
	const text = await renderLine("ja");
	for (const value of Object.values(JA)) {
		expect(text).toContain(value);
	}
	expect(text).not.toContain("Cooking, longer than usual");
	expect(text).not.toContain("Burnt order");
});

test("English keeps the source copy", async () => {
	const text = await renderLine("en");
	expect(text).toContain("Idle");
	expect(text).toContain("Cooking, longer than usual");
	expect(text).toContain("Burnt order");
});
