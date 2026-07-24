// Render-through-the-host tests for the shared Skills catalog *list*. Same idiom
// as the Apps section: inject a fake CatalogHost, render to static markup. The
// detail/files preview mounts in a portaled <Dialog> (not emitted by
// `renderToStaticMarkup`); its helpers are unit-tested in
// skills-catalog-helpers.test.ts. Here we cover the list states and that
// `formatCount` reaches the card subtitle.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstall,
} from "./host.tsx";
import SkillsCatalogSection from "./skills-catalog-section.tsx";
import type { SkillCard, SkillsCatalogState } from "./types.ts";

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => <button type="button">{children}</button>,
};

function skill(over: Partial<SkillCard> = {}): SkillCard {
	return {
		id: "acme/repo/thing",
		installed: false,
		installs: 0,
		name: "Thing",
		slug: "thing",
		source: "acme",
		...over,
	};
}

function makeSkillsState(
	over: Partial<SkillsCatalogState> = {}
): SkillsCatalogState {
	return {
		activeSource: "skills-sh",
		addingMarketplace: false,
		addMarketplace: () => Promise.resolve(),
		detail: null,
		detailError: null,
		detailLoading: false,
		enabledByKey: {},
		error: null,
		fetchNextPage: () => undefined,
		hasNextPage: false,
		install: () => Promise.resolve(),
		installedOnly: false,
		installing: null,
		loading: false,
		org: "",
		query: "",
		select: () => undefined,
		selectedId: null,
		selectingSource: false,
		selectSource: () => undefined,
		setInstalledOnly: () => undefined,
		setOrg: () => undefined,
		setQuery: () => undefined,
		setSkillEnabled: () => Promise.resolve(),
		setSort: () => undefined,
		skills: [],
		sort: "popular",
		sources: [{ builtin: true, displayName: "skills.sh", id: "skills-sh" }],
		togglingSkill: null,
		...over,
	};
}

function makeHost(
	state: SkillsCatalogState,
	install: CatalogInstall | null = MOCK_INSTALL
): CatalogHost {
	return {
		install,
		Markdown: ({ content }) => <div>{content}</div>,
		openExternal: () => undefined,
		renderAffordance: (target) => <span>Open {target.name} in Ryu</span>,
		useAppsCatalog: () => {
			throw new Error("unused");
		},
		useSkillsCatalog: () => state,
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ url: "", token: null }),
		usePersistedToggle: (_k: string, d: boolean) =>
			[d, () => undefined] as [boolean, (v: boolean) => void],
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

function render(
	state: SkillsCatalogState,
	install: CatalogInstall | null = MOCK_INSTALL
): string {
	return renderToStaticMarkup(
		<CatalogHostProvider host={makeHost(state, install)}>
			<SkillsCatalogSection />
		</CatalogHostProvider>
	);
}

describe("SkillsCatalogSection — list states", () => {
	test("error surfaces the message", () => {
		const html = render(makeSkillsState({ error: "nope" }));
		// The apostrophe in "Couldn't" is HTML-escaped in static markup.
		expect(html).toContain("load skills: nope");
	});

	test("empty (loaded, no skills) shows the empty state", () => {
		const html = render(makeSkillsState({ skills: [] }));
		expect(html).toContain("No skills found");
	});

	test("loading with no skills shows a spinner, not the empty state", () => {
		const html = render(makeSkillsState({ loading: true, skills: [] }));
		expect(html).not.toContain("No skills found");
	});

	test("populated: card shows the name and a friendly install count", () => {
		const html = render(
			makeSkillsState({
				skills: [
					skill({
						id: "a",
						installs: 1_500_000,
						name: "Popular",
						source: "org",
					}),
				],
			})
		);
		// friendly mode (default ON via getServerSnapshot) title-cases the name.
		expect(html).toContain("Popular");
		// formatCount(1_500_000) -> "1.5M", wired into the "source · N installs" line.
		expect(html).toContain("1.5M installs");
		expect(html).toContain("org");
	});

	test("a zero-install skill shows just the source, no install count", () => {
		const html = render(
			makeSkillsState({
				skills: [
					skill({ id: "b", installs: 0, name: "Fresh", source: "solo" }),
				],
			})
		);
		expect(html).toContain("solo");
		expect(html).not.toContain("installs");
	});
});
