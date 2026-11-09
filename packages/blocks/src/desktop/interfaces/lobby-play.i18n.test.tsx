import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { LobbyPlay } = await import("./lobby-play.tsx");

// The catalog's bare "Brief" is the adjective (簡潔, "concise"); the heading
// over the prompt field is the briefing for the next match.
const JA: Record<string, string> = {
	Brief: "簡潔",
	Briefing: "ブリーフィング",
	Mode: "モード",
};

const ADA = {
	avatarUrl: null,
	description: "Ada agent",
	id: "agent-ada",
	name: "Ada",
	status: "idle" as const,
};

afterEach(() => {
	registerLiteralCatalogLoader(null);
	document.body.replaceChildren();
});

afterAll(async () => {
	await GlobalRegistrator.unregister();
});

test("the Japanese lobby heads the open brief as a briefing", async () => {
	registerLiteralCatalogLoader((locale) => (locale.startsWith("ja") ? JA : {}));
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider initialLocale="ja" initialPackId={null}>
				<LobbyPlay
					members={[]}
					onPick={() => undefined}
					onStart={() => undefined}
					selected={ADA}
					squadIds={[]}
				/>
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(container.querySelector("h2")?.textContent).toBe("モード");

	const play = container.querySelector<HTMLButtonElement>(
		'button[type="button"][aria-label]:not([aria-haspopup])'
	);
	await act(async () => {
		play?.click();
	});
	// Let the DOM localizer pass over the swapped heading.
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});

	expect(container.querySelector("h2")?.textContent).toBe("ブリーフィング");
	expect(container.textContent).not.toContain("簡潔");

	await act(async () => root.unmount());
	container.remove();
});
