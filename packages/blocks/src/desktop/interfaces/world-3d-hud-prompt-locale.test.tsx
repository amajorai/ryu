import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { I18nProvider } from "@ryu/i18n/react";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// The 3D world's controls line labels the E key. "Talk" alone is the wiki
// talk-page tab ("ノート") and "Answer" alone is the noun ("回答"), so the line
// looks up its own whole messages. The WASD hint is "Move around", not the
// bare "Move" key that file actions translate as "Move to trash:".
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { Village3dPrompt } = await import("./world-3d-hud.tsx");

const JA: Record<string, string> = {
	Answer: "回答",
	"Answer them": "返事をする",
	"Drag to look around": "ドラッグして見回す",
	"Loading agents": "エージェントを読み込み中",
	Move: "ゴミ箱へ移動:",
	"Move around": "歩き回る",
	Talk: "ノート",
	"Talk to them": "話しかける",
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

async function renderIn(locale: string, node: ReactNode): Promise<HTMLElement> {
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
				{node}
			</I18nProvider>
		);
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return container;
}

test("the E key reads as talking to an agent, not the wiki tab", async () => {
	const container = await renderIn(
		"ja",
		<Village3dPrompt loading={false} nearbyName={null} orbit={false} />
	);
	expect(container.textContent).toContain("話しかける");
	expect(container.textContent).not.toContain("ノート");
});

test("an asking agent's E key reads as answering it, not the noun", async () => {
	const container = await renderIn(
		"ja",
		<Village3dPrompt answer loading={false} nearbyName={null} orbit={false} />
	);
	expect(container.textContent).toContain("返事をする");
	expect(container.textContent).not.toContain("回答");
});

test("English keeps whole messages", async () => {
	const container = await renderIn(
		"en",
		<Village3dPrompt loading={false} nearbyName={null} orbit={false} />
	);
	expect(container.textContent).toContain("Talk to them");
});

test("the WASD hint is its own message, not the file-action Move", async () => {
	const container = await renderIn(
		"ja",
		<Village3dPrompt loading={false} nearbyName={null} orbit />
	);
	expect(container.textContent).toContain("歩き回る");
	expect(container.textContent).toContain("ドラッグして見回す");
	expect(container.textContent).not.toContain("ゴミ箱");
	expect(container.textContent).not.toMatch(/Move|Drag/u);
});

test("the loading line is translated, not left in English", async () => {
	const container = await renderIn(
		"ja",
		<Village3dPrompt loading nearbyName={null} orbit={false} />
	);
	expect(container.textContent).toBe("エージェントを読み込み中");
});
