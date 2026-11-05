import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { registerLiteralCatalogLoader } from "@ryu/i18n/core";
import { I18nProvider } from "@ryu/i18n/react";
import type {
	InterfaceAgent,
	InterfaceSnapshot,
} from "@ryuhq/protocol/interfaces";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

// The village's controls hint labels the E key. The bare "Talk" source is the
// wiki's talk-page tab ("ノート"), so the hint looks up its own whole message
// ("Talk to them") and never shows the tab's noun.
const ownsDom = typeof document === "undefined";
if (ownsDom) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { World2dInterface } = await import("./world-2d-interface.tsx");

const JA: Record<string, string> = {
	Talk: "ノート",
	"Talk to them": "話しかける",
};

function agent(id: string, name: string): InterfaceAgent {
	return { avatarUrl: null, description: "", id, name, status: "idle" };
}

const SNAPSHOT: InterfaceSnapshot = {
	agents: [agent("agent-ada", "Ada"), agent("agent-grace", "Grace")],
	groups: [],
	threads: [],
	version: 1,
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

async function renderIn(locale: string): Promise<HTMLElement> {
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
				<World2dInterface
					activeThreadId={null}
					loading={false}
					params={{ theme: "meadow" }}
					port={{
						closeThread: () => undefined,
						openThread: () => undefined,
						startThread: () => undefined,
					}}
					snapshot={SNAPSHOT}
					threadView={null}
				/>
			</I18nProvider>
		);
	});
	// A test stage has no width, so the hint starts closed: open it with "?".
	const help = container.querySelector<HTMLButtonElement>(
		'button[aria-keyshortcuts="?"]'
	);
	if (!help) {
		throw new Error("missing controls button");
	}
	await act(async () => {
		help.click();
	});
	return container;
}

test("Japanese: the E-key hint is the verb, not the wiki tab's noun", async () => {
	const container = await renderIn("ja");
	expect(container.textContent).toContain("話しかける");
	expect(container.textContent).not.toContain("ノート");
});

test("English keeps the whole message", async () => {
	const container = await renderIn("en");
	expect(container.textContent).toContain("Talk to them");
});
