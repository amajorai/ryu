// A usage row's meta line is built from whole messages ("{provider} via
// {upstream}", "{inputTokens} in · {outputTokens} out"), so a German catalog
// can reorder them and translate the "Provider" fallback.

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
const { UsageView } = await import("./usage.tsx");
type Row = import("./usage.tsx").UsageRow;

const DE: Record<string, string> = {
	Provider: "Anbieter",
	"{inputTokens} in · {outputTokens} out":
		"{inputTokens} rein · {outputTokens} raus",
	"{provider} via {upstream}": "{provider} über {upstream}",
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

function row(overrides: Partial<Row>): Row {
	return {
		balanceAfter: 0,
		createdAtLabel: "Today",
		delta: -1000,
		durationMs: null,
		id: "row-1",
		inputTokens: 12,
		isCredit: false,
		model: null,
		outputTokens: 3,
		provider: null,
		reason: "inference",
		taskLabel: null,
		upstreamProvider: "acme-cloud",
		...overrides,
	};
}

async function renderRowsIn(locale: string, rows: Row[]): Promise<string> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("de") ? DE : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<UsageView
					hasMore={false}
					loading={false}
					loadingMore={false}
					onLoadMore={() => undefined}
					onRefresh={() => undefined}
					rows={rows}
					summary={null}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

test("English keeps the via and token wording", async () => {
	const text = await renderRowsIn("en", [row({})]);
	expect(text).toContain("Provider via acme-cloud");
	expect(text).toContain("12 in · 3 out");
});

test("German translates the via row, its fallback and the token counts", async () => {
	const text = await renderRowsIn("de", [row({})]);
	expect(text).toContain("Anbieter über acme-cloud");
	expect(text).toContain("12 rein · 3 raus");
	expect(text).not.toContain(" via ");
});
