import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { I18nProvider, useLiteralMessages } = await import("@ryu/i18n/react");
const { registerLiteralCatalogLoader } = await import("@ryu/i18n/core");
const { activeModelHelper } = await import("./ActiveModelControl-helper.ts");

import type { ModelEngineChoice } from "@/src/lib/model-engine.ts";

// German puts the engine name at the end of a subordinate clause, so the
// sentence has to be one catalog entry with a slot, not English glued around it.
const CATALOGS: Record<string, Record<string, string>> = {
	de: {
		"Ready on {engine}.": "Bereit auf {engine}.",
		"{engine} is already installing on this node.":
			"Auf diesem Knoten wird {engine} bereits installiert.",
		"{engine} will be installed if this node needs it.":
			"Falls dieser Knoten es braucht, wird {engine} installiert.",
	},
	ja: { "Ready on {engine}.": "{engine} で準備完了です。" },
};

const roots: Root[] = [];

afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) {
			root.unmount();
		}
	});
	document.body.replaceChildren();
	registerLiteralCatalogLoader(null);
});

function engine(
	installState: ModelEngineChoice["installState"]
): ModelEngineChoice {
	return { displayName: "llama.cpp", installState, name: "llamacpp" };
}

function Helper({ engineChoice }: { engineChoice: ModelEngineChoice | null }) {
	const tl = useLiteralMessages();
	return (
		<p>
			{activeModelHelper(tl, {
				engineChoice,
				engineCheckFailed: false,
				unavailable: engineChoice === null,
			})}
		</p>
	);
}

async function renderHelper(
	locale: string,
	engineChoice: ModelEngineChoice | null
): Promise<string> {
	registerLiteralCatalogLoader((tag) => CATALOGS[tag.split("-")[0]] ?? {});
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(
			<I18nProvider
				autoLocalizeDom={false}
				initialLocale={locale}
				initialPackId={null}
			>
				<Helper engineChoice={engineChoice} />
			</I18nProvider>
		);
	});
	await act(async () => {
		await Promise.resolve();
	});
	return container.textContent ?? "";
}

test("a German helper places the engine name where German needs it", async () => {
	expect(await renderHelper("de", engine("installed"))).toBe(
		"Bereit auf llama.cpp."
	);
	expect(await renderHelper("de", engine("installing"))).toBe(
		"Auf diesem Knoten wird llama.cpp bereits installiert."
	);
	expect(await renderHelper("de", engine("not_installed"))).toBe(
		"Falls dieser Knoten es braucht, wird llama.cpp installiert."
	);
});

test("a Japanese helper puts the engine first", async () => {
	expect(await renderHelper("ja", engine("installed"))).toBe(
		"llama.cpp で準備完了です。"
	);
});

test("an English helper keeps the source sentences", async () => {
	expect(await renderHelper("en", engine("installing"))).toBe(
		"llama.cpp is already installing on this node."
	);
	expect(await renderHelper("en", null)).toBe(
		"This node has no compatible local engine for this model format."
	);
});
