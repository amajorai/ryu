// A ledger row's system task label (Box slugs, mail overage, metered service
// windows) renders in the reader's language through
// `localizeUsageTaskLabel`; a user's own task name stays as written.

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
	"Box storage": "Box-Speicher",
	"Mail overage: {count, plural, one {# recipient} other {# recipients}}":
		"Mail-Überschreitung: {count, plural, one {# Empfänger} other {# Empfänger}}",
	"Passport usage, {window}": "Passport-Nutzung, {window}",
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

test("German renders system task labels and keeps a user's task name", async () => {
	const text = await renderRowsIn("de", [
		row({ id: "a", taskLabel: "box-storage" }),
		row({ id: "b", taskLabel: "Mail overage: 12 recipients" }),
		row({
			id: "c",
			taskLabel:
				"passport usage 2026-11-06T10:00:00.000Z–2026-11-06T11:00:00.000Z",
		}),
		row({ id: "d", taskLabel: "Draft release notes" }),
	]);
	expect(text).toContain("Box-Speicher");
	expect(text).toContain("Mail-Überschreitung: 12 Empfänger");
	expect(text).toContain("Passport-Nutzung, ");
	expect(text).not.toContain("2026-11-06T");
	expect(text).not.toContain("box-storage");
	expect(text).toContain("Draft release notes");
});
