// The detail hero's Get must route an unverified (dotted) publisher through the
// same two-step disclosure as the cards; opening a card lands on this hero, so a
// direct install here would be a one-click bypass.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogHost, CatalogInstall } from "./host.tsx";
import type { AppCatalogItem, AppsCatalogState } from "./types.ts";

if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { CatalogHostProvider } = await import("./host.tsx");
const { default: AppsCatalogSection } = await import(
	"./apps-catalog-section.tsx"
);

const DOTTED_ITEM: AppCatalogItem = {
	enabled: false,
	entry: {
		description: "A listing from an unverified publisher.",
		id: "com.example.dotted",
		kinds: ["tool"],
		name: "Dotted Plugin",
		publisher_trust: "dotted",
		tags: [],
		version: "1.0.0",
	},
	grants: [],
	installed: false,
};

const HERO_INSTALL: CatalogInstall = {
	InstallButton: ({ children, onClick }) => (
		<button data-testid="hero-install" onClick={onClick} type="button">
			{children}
		</button>
	),
};

function makeState(install: AppsCatalogState["install"]): AppsCatalogState {
	return {
		activeSource: "ryu-marketplace",
		addingMarketplace: false,
		addMarketplace: async () => undefined,
		detail: null,
		detailError: null,
		detailLoading: false,
		error: null,
		fetchNextPage: () => undefined,
		hasNextPage: false,
		install,
		installFromUrl: async () => undefined,
		installing: null,
		items: [DOTTED_ITEM],
		lifecyclePending: false,
		loading: false,
		loadingMore: false,
		query: "",
		select: () => undefined,
		selectedId: DOTTED_ITEM.entry.id,
		selectedItem: DOTTED_ITEM,
		selectingSource: false,
		selectSource: () => undefined,
		setEnabled: async () => undefined,
		setQuery: () => undefined,
		sources: [{ displayName: "Ryu Marketplace", id: "ryu-marketplace" }],
	};
}

function makeHost(state: AppsCatalogState): CatalogHost {
	return {
		install: HERO_INSTALL,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: () => null,
		useAppsCatalog: () => state,
		useSkillsCatalog: () => {
			throw new Error("unused");
		},
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ token: null, url: "" }),
		usePersistedToggle: (_key: string, defaultValue: boolean) => [
			defaultValue,
			() => undefined,
		],
		installSidecar: async () => undefined,
		estimateLlmfit: async () => ({
			fit_level: null,
			installed: false,
			matched: false,
			min_vram_gb: null,
			path: null,
			tps: null,
		}),
		useInstalledModels: () => [],
		ActiveModelControl: () => null,
		fitStyle: () => ({ className: "", dot: "" }),
	};
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	document.body.replaceChildren();
});

function button(name: string): HTMLButtonElement {
	for (const candidate of document.querySelectorAll<HTMLButtonElement>(
		"button"
	)) {
		if (candidate.textContent?.trim() === name) {
			return candidate;
		}
	}
	throw new Error(`Missing button: ${name}`);
}

async function click(el: HTMLElement) {
	await act(async () => {
		el.click();
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
}

describe("AppsCatalogSection detail hero — unverified publisher", () => {
	test("Get opens the disclosure and installs only after confirmation", async () => {
		const install = mock(async () => undefined);
		await act(async () => {
			root.render(
				<CatalogHostProvider host={makeHost(makeState(install))}>
					<AppsCatalogSection />
				</CatalogHostProvider>
			);
			await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
		});

		const hero = document.querySelector<HTMLButtonElement>(
			'[data-testid="hero-install"]'
		);
		expect(hero).not.toBeNull();
		await click(hero as HTMLButtonElement);
		expect(install).not.toHaveBeenCalled();
		expect(document.body.textContent).toContain(
			"This publisher is not verified"
		);

		await click(button("Review risk and continue"));
		expect(install).not.toHaveBeenCalled();

		await click(button("I understand the risk, install"));
		expect(install).toHaveBeenCalledTimes(1);
		expect(install).toHaveBeenCalledWith(DOTTED_ITEM.entry.id, undefined);
	});
});
