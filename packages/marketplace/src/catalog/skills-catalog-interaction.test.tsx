import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { CatalogHost, CatalogInstall } from "./host.tsx";
import type { SkillCard, SkillDetail, SkillsCatalogState } from "./types.ts";

if (typeof document === "undefined") {
	GlobalRegistrator.register();
}

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
Reflect.set(Element.prototype, "getAnimations", () => []);

const { CatalogHostProvider } = await import("./host.tsx");
const { default: SkillsCatalogSection } = await import(
	"./skills-catalog-section.tsx"
);

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => <button type="button">{children}</button>,
};

function installedCard(): SkillCard {
	return {
		id: "installed-skill",
		installed: true,
		installs: 1,
		name: "Installed skill",
		slug: "installed-skill",
		source: "ryu",
	};
}

function installedDetail(): SkillDetail {
	return {
		card: installedCard(),
		description: "A locally installed skill.",
		files: [],
		metadata: {
			firstSeen: null,
			githubCreatedAt: null,
			githubPushedAt: null,
			githubStars: null,
			githubUpdatedAt: null,
			installs: null,
			repositoryUrl: null,
			securityAudits: [],
		},
		readme: null,
		url: "https://example.com/installed-skill",
	};
}

function usePersistedToggle(
	_key: string,
	defaultValue: boolean
): [boolean, (value: boolean) => void] {
	return [defaultValue, () => undefined];
}

function state(): SkillsCatalogState {
	return {
		activeSource: "skills-sh",
		addingMarketplace: false,
		addMarketplace: async () => undefined,
		detail: installedDetail(),
		detailError: null,
		detailLoading: false,
		enabledByKey: { "installed-skill": true },
		error: null,
		fetchNextPage: () => undefined,
		hasNextPage: false,
		install: async () => undefined,
		installedOnly: false,
		installing: null,
		loading: false,
		org: "",
		query: "",
		removeMarketplace: async () => undefined,
		reorderMarketplace: async () => undefined,
		select: () => undefined,
		selectedId: "installed-skill",
		selectingSource: false,
		selectSource: () => undefined,
		setInstalledOnly: () => undefined,
		setOrg: () => undefined,
		setQuery: () => undefined,
		setSkillEnabled: async () => undefined,
		setSort: () => undefined,
		skills: [installedCard()],
		sort: "popular",
		sources: [{ builtin: true, displayName: "skills.sh", id: "skills-sh" }],
		togglingSkill: null,
	};
}

function host(
	distributeSkill?: (skillId: string) => Promise<void>
): CatalogHost {
	return {
		distributeSkill,
		install: MOCK_INSTALL,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: () => null,
		useAppsCatalog: () => {
			throw new Error("unused");
		},
		useSkillsCatalog: state,
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ token: null, url: "" }),
		usePersistedToggle,
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

async function render(distributeSkill?: (skillId: string) => Promise<void>) {
	await act(async () => {
		root.render(
			<CatalogHostProvider host={host(distributeSkill)}>
				<SkillsCatalogSection />
			</CatalogHostProvider>
		);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	});
}

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

describe("SkillsCatalogSection — installed skill distribution", () => {
	test("passes the resolved installed skill id to Use with agents", async () => {
		const distributeSkill = mock(async () => undefined);
		await render(distributeSkill);

		await act(async () => {
			button("Use with agents").click();
			await Promise.resolve();
		});

		expect(distributeSkill).toHaveBeenCalledWith("installed-skill");
	});

	test("omits Use with agents when the host has no callback", async () => {
		await render();

		expect(
			Array.from(document.querySelectorAll("button")).some(
				(candidate) => candidate.textContent?.trim() === "Use with agents"
			)
		).toBeFalse();
	});
});
