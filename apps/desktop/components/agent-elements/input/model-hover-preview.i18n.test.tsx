import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ModelInsight } from "@/src/lib/api/model-insight.ts";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { ModelHoverPreview } = await import("./model-hover-preview.tsx");

/*
 * A screen reader names each score bar in the reader's language: "速度: 5 段階中 4"
 * in Japanese, never "Speed: 4 of 5".
 */
const JA: Record<string, string> = {
	Context: "コンテキスト",
	Cost: "コスト",
	Intelligence: "知能",
	Speed: "速度",
	"{label}: {score} of 5": "{label}: 5 段階中 {score}",
	"{label}: {score} of 5, {hint}": "{label}: 5 段階中 {score}（{hint}）",
	"{label}: unknown": "{label}: 不明",
};

const INSIGHT: ModelInsight = {
	aaKeyPresent: false,
	id: "model-a",
	intelligenceIndex: 61,
	modalitiesInput: ["text"],
	modalitiesOutput: ["text"],
	name: "Model A",
	scoreContext: null,
	scoreCost: 3,
	scoreIntelligence: 4.5,
	scoreSpeed: 4,
	source: "catalog",
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.innerHTML = "";
});

async function scoreLabels(locale: string): Promise<(string | null)[]> {
	registerLiteralCatalogLoader((requested) =>
		requested.startsWith("ja") ? JA : {}
	);
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale={locale} initialPackId={null}>
				<ModelHoverPreview insight={INSIGHT} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	const labels = [
		...container.querySelectorAll('[data-slot="model-score-bar"]'),
	].map((bar) => bar.getAttribute("aria-label"));
	await act(async () => root.unmount());
	return labels;
}

test("score bar names are whole Japanese sentences", async () => {
	expect(await scoreLabels("ja")).toEqual([
		"速度: 5 段階中 4",
		"知能: 5 段階中 4.5（61）",
		"コスト: 5 段階中 3",
		"コンテキスト: 不明",
	]);
});

test("English score bar names keep their wording", async () => {
	expect(await scoreLabels("en")).toEqual([
		"Speed: 4 of 5",
		"Intelligence: 4.5 of 5, 61",
		"Cost: 3 of 5",
		"Context: unknown",
	]);
});
