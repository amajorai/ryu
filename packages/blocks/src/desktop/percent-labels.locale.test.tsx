import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// Visible percentages (install progress, prompt-cache hit rate, the usage
// dashboard's cache-reuse figures) format through formatPercent, so German
// readers see "42 %" like everywhere else instead of a hand-built "42%".
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { InstallProgressButton } = await import("./install-button.tsx");
const { PromptCacheSummary } = await import(
	"./agent-elements/prompt-cache-summary.tsx"
);
const { formatPercent: formatCachePercent } = await import(
	"./usage-analytics-dashboard-prompt-cache.tsx"
);

const DE_PERCENT = "42 %";

let mounted: { container: HTMLElement; root: Root } | undefined;
afterEach(async () => {
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

async function renderIn(locale: string, node: ReactNode): Promise<HTMLElement> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	mounted = { container, root };
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				{node}
			</I18nProvider>
		);
	});
	return container;
}

test("install progress prints the German percent format", async () => {
	const container = await renderIn(
		"de",
		<InstallProgressButton installing percent={42}>
			Download
		</InstallProgressButton>
	);
	expect(container.textContent).toContain(DE_PERCENT);
	expect(container.textContent).not.toContain("42%");
});

test("install progress keeps the English form in English", async () => {
	const container = await renderIn(
		"en",
		<InstallProgressButton installing percent={42}>
			Download
		</InstallProgressButton>
	);
	expect(container.textContent).toContain("42%");
});

test("prompt-cache hit rate prints the German percent format", async () => {
	const container = await renderIn(
		"de",
		<PromptCacheSummary
			usage={{ cacheReadTokens: 42, promptTokens: 100, total: 1000, used: 100 }}
		/>
	);
	expect(container.textContent).toContain(DE_PERCENT);
});

test("usage dashboard cache percentages follow the mounted locale", async () => {
	await renderIn("de", null);
	expect(formatCachePercent(0.42)).toBe(DE_PERCENT);
	expect(formatCachePercent(null)).toBe("—");
});
