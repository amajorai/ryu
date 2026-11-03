// The composer question card's "2 of 3" counter is one whole message, so a
// German catalog reads "2 von 3" instead of an English connector between
// two numbers (which the DOM localizer cannot match: too few letters).

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
const { useComposerQuestionBar } = await import("./input-bar-question-bar.tsx");
type QuestionBar = NonNullable<
	import("./input-bar-types.ts").InputBarProps["questionBar"]
>;

const DE: Record<string, string> = {
	"{current} of {total}": "{current} von {total}",
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

const questionBar: QuestionBar = {
	id: "q-1",
	onSubmit: () => undefined,
	questionIndex: 2,
	onNextQuestion: () => undefined,
	questions: [
		{ kind: "text", title: "First?" },
		{ kind: "text", title: "Second?" },
		{ kind: "text", title: "Third?" },
	],
};

function Probe() {
	const { questionBarNode } = useComposerQuestionBar(questionBar, undefined);
	return <div>{questionBarNode}</div>;
}

async function counterIn(locale: string): Promise<string> {
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
				<Probe />
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container.textContent ?? "";
}

test("the counter reads in English and in German", async () => {
	expect(await counterIn("en")).toContain("2 of 3");
	expect(await counterIn("de")).toContain("2 von 3");
});
