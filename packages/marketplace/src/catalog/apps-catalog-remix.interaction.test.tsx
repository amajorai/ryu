import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogHost, CatalogInstall } from "./host.tsx";
import type {
	AppCatalogItem,
	AppsCatalogState,
	CatalogEntry,
} from "./types.ts";

// The desktop Remix button and the Remix rows of an app's detail dialog, mounted
// through the real Apps section and its real Dialog. The host is the injection
// seam every catalog test fills in; what the dialog decides (the fork link and
// which rows appear) comes from the shared remix rules, not from the host.
if (globalThis.document === undefined) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { CatalogHostProvider } = await import("./host.tsx");
const { default: AppsCatalogSection } = await import(
	"./apps-catalog-section.tsx"
);

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => <button type="button">{children}</button>,
};

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		description: "Does a thing.",
		id: "acme/tool",
		kinds: ["tool"],
		name: "Tool",
		tags: [],
		type: "plugin",
		version: "1.0.0",
		...over,
	};
}

function item(
	over: Partial<CatalogEntry> = {},
	installed = false
): AppCatalogItem {
	return {
		enabled: installed,
		entry: entry(over),
		grants: [],
		installed,
	};
}

function state(selected: AppCatalogItem): AppsCatalogState {
	return {
		activeSource: "ryu-marketplace",
		addingMarketplace: false,
		addMarketplace: () => Promise.resolve(),
		detail: null,
		detailError: null,
		detailLoading: false,
		error: null,
		fetchNextPage: () => undefined,
		hasNextPage: false,
		install: () => Promise.resolve(),
		installFromUrl: () => Promise.resolve(),
		installing: null,
		items: [selected],
		lifecyclePending: false,
		loading: false,
		loadingMore: false,
		query: "",
		select: () => undefined,
		selectedId: selected.entry.id,
		selectedItem: selected,
		selectingSource: false,
		selectSource: () => undefined,
		setEnabled: () => Promise.resolve(),
		setQuery: () => undefined,
		sources: [{ displayName: "Ryu Marketplace", id: "ryu-marketplace" }],
	};
}

const EMPTY_STATE: AppsCatalogState = {
	...state(item()),
	items: [],
	selectedId: null,
	selectedItem: null,
};

function host(selected: AppCatalogItem): CatalogHost {
	return {
		install: MOCK_INSTALL,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: () => null,
		// The section reads two feeds: the first-party catalog and the community
		// shelf. Only the first holds the selection under test.
		useAppsCatalog: (_query, options) =>
			options?.origin === "community" ? EMPTY_STATE : state(selected),
		useSkillsCatalog: () => {
			throw new Error("unused");
		},
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ token: null, url: "" }),
		usePersistedToggle: (_key: string, value: boolean) => [
			value,
			() => undefined,
		],
		installSidecar: () => Promise.resolve(),
		estimateLlmfit: () =>
			Promise.resolve({
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

async function openDetail(over: Partial<CatalogEntry>, installed = false) {
	await act(async () => {
		root.render(
			<CatalogHostProvider host={host(item(over, installed))}>
				<AppsCatalogSection />
			</CatalogHostProvider>
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
}

/** The desktop Remix control: an anchor named for the listing it forks. */
function remixLink(): HTMLAnchorElement | null {
	return document.querySelector<HTMLAnchorElement>(
		'a[aria-label^="Remix "][aria-label$=" by forking its source on GitHub"]'
	);
}

/** The value beside an Information row label in the detail aside. */
function infoValue(label: string): string | null {
	for (const term of document.querySelectorAll("dt")) {
		if (term.textContent?.trim() === label) {
			return term.nextElementSibling?.textContent?.trim() ?? null;
		}
	}
	return null;
}

/** The detail dialog is open on the listing: its Information card shows the
 *  version. A control that is absent is only evidence if this holds. */
function detailIsOpen(): boolean {
	return infoValue("Version") === "1.0.0";
}

describe("the desktop Remix button", () => {
	test("forks a GitHub-backed listing from its bound source", async () => {
		await openDetail({
			github_source: { repository: "acme/bound" },
			repository_url: "https://github.com/acme/declared",
		});
		const link = remixLink();
		expect(link?.getAttribute("aria-label")).toBe(
			"Remix Tool by forking its source on GitHub"
		);
		expect(link?.getAttribute("href")).toBe(
			"https://github.com/acme/bound/fork"
		);
		expect(link?.getAttribute("target")).toBe("_blank");
		expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
		expect(link?.textContent?.trim()).toBe("Remix");
	});

	test("forks the declared repository when no source is bound", async () => {
		await openDetail({
			repository_url: "https://github.com/acme/declared.git",
		});
		expect(remixLink()?.getAttribute("href")).toBe(
			"https://github.com/acme/declared/fork"
		);
	});

	test("falls back to the catalog's repo_url", async () => {
		await openDetail({ repo_url: "acme/short" });
		expect(remixLink()?.getAttribute("href")).toBe(
			"https://github.com/acme/short/fork"
		);
	});

	test("is offered for an installed listing too", async () => {
		await openDetail({ github_source: { repository: "acme/tool" } }, true);
		expect(remixLink()?.getAttribute("href")).toBe(
			"https://github.com/acme/tool/fork"
		);
	});

	test("is hidden when the author opted out, even with a public repository", async () => {
		await openDetail({
			allow_remix: false,
			github_source: { repository: "acme/tool" },
		});
		expect(remixLink() !== null).toBe(false);
		expect(detailIsOpen()).toBe(true);
	});

	test("is hidden when the listing has no GitHub source", async () => {
		await openDetail({});
		expect(remixLink() !== null).toBe(false);
		expect(detailIsOpen()).toBe(true);
	});

	test("is hidden for a repository that is not on GitHub", async () => {
		await openDetail({ repository_url: "https://gitlab.com/acme/tool" });
		expect(remixLink() !== null).toBe(false);
		expect(detailIsOpen()).toBe(true);
		await openDetail({ repository_url: "javascript:alert(1)" });
		expect(remixLink() !== null).toBe(false);
		expect(detailIsOpen()).toBe(true);
	});
});

describe("the Remix rows of the detail dialog", () => {
	test("credits the listing a remix copies", async () => {
		await openDetail({
			remixed_from: { id: " ryu/animator ", kind: "agent", version: "1.0.0" },
		});
		expect(infoValue("Remixed from")).toBe("ryu/animator");
	});

	test("shows no credit for an original or a malformed credit", async () => {
		await openDetail({});
		expect(detailIsOpen()).toBe(true);
		expect(infoValue("Remixed from")).toBeNull();
		await openDetail({ remixed_from: { id: "ryu/animator", kind: "" } });
		expect(detailIsOpen()).toBe(true);
		expect(infoValue("Remixed from")).toBeNull();
		await openDetail({ remixed_from: { id: "", kind: "agent" } });
		expect(infoValue("Remixed from")).toBeNull();
	});

	test("says remixing is not allowed only when the author opted out", async () => {
		await openDetail({ allow_remix: false });
		expect(infoValue("Remixing")).toBe("Not allowed by the author");
		await openDetail({ allow_remix: true });
		expect(detailIsOpen()).toBe(true);
		expect(infoValue("Remixing")).toBeNull();
		await openDetail({ allow_remix: null });
		expect(infoValue("Remixing")).toBeNull();
		await openDetail({});
		expect(infoValue("Remixing")).toBeNull();
	});
});
