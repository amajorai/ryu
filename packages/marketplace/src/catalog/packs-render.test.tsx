// Render-through-the-host test for the shared Skills catalog's Packs shelf. Same
// idiom as the skills list test: inject a fake CatalogHost carrying a
// `useSkillPacks` hook and render to static markup. Covers the browse shelf, the
// opened-pack member view, and that a host WITHOUT the hook renders no shelf.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { packAvatarUrl } from "./chrome/pack-catalog-card.tsx";
import { skillAvatarUrl } from "./chrome/skill-badge-card.tsx";
import {
	type CatalogHost,
	CatalogHostProvider,
	type CatalogInstall,
} from "./host.tsx";
import type {
	SkillPackCard,
	SkillPackDetail,
	SkillPacksState,
} from "./pack-types.ts";
import SkillsCatalogSection from "./skills-catalog-section.tsx";
import type { SkillCard, SkillsCatalogState } from "./types.ts";

const MOCK_INSTALL: CatalogInstall = {
	InstallButton: ({ children }) => <button type="button">{children}</button>,
};

function makeSkillsState(): SkillsCatalogState {
	return {
		activeSource: "skills-sh",
		addingMarketplace: false,
		addMarketplace: () => Promise.resolve(),
		removeMarketplace: () => Promise.resolve(),
		reorderMarketplace: () => Promise.resolve(),
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
	};
}

function makePackState(over: Partial<SkillPacksState> = {}): SkillPacksState {
	return {
		error: null,
		installing: null,
		install: () => Promise.resolve([]),
		loading: false,
		open: () => undefined,
		opened: null,
		opening: null,
		packs: [],
		refresh: () => undefined,
		...over,
	};
}

function makeHost(
	skills: SkillsCatalogState,
	packs: SkillPacksState,
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
		useSkillsCatalog: () => skills,
		useSkillPacks: () => packs,
		useModelCatalog: () => {
			throw new Error("unused");
		},
		useActiveNode: () => ({ url: "", token: null }),
		usePersistedToggle: (_k: string, d: boolean) => [d, () => undefined],
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

function render(skills: SkillsCatalogState, packs: SkillPacksState): string {
	return renderToStaticMarkup(
		<CatalogHostProvider host={makeHost(skills, packs)}>
			<SkillsCatalogSection />
		</CatalogHostProvider>
	);
}

describe("SkillsCatalogSection — packs shelf", () => {
	const pack: SkillPackCard = {
		id: "mattpocock/skills",
		name: "Mattpocock Skills",
		description: "A pack of skills.",
		builtin: true,
		memberCount: 3,
	};

	test("host without useSkillPacks renders no shelf", () => {
		const host: CatalogHost = makeHost(makeSkillsState(), makePackState());
		// Delete the optional seam to simulate a host with no pack feed.
		host.useSkillPacks = undefined;
		const html = renderToStaticMarkup(
			<CatalogHostProvider host={host}>
				<SkillsCatalogSection />
			</CatalogHostProvider>
		);
		expect(html).not.toContain("Skill packs");
	});

	test("browse shelf lists the pack with its member count", () => {
		const html = render(makeSkillsState(), makePackState({ packs: [pack] }));
		expect(html).toContain("Featured skill packs");
		expect(html).toContain(
			"Optional onboarding picks stay here to browse or install later."
		);
		expect(html).toContain("Mattpocock Skills");
		expect(html).toContain("3 skills");
	});

	test("read-only hosts do not show a non-functional install button", () => {
		const html = renderToStaticMarkup(
			<CatalogHostProvider
				host={makeHost(
					makeSkillsState(),
					makePackState({ packs: [pack] }),
					null
				)}
			>
				<SkillsCatalogSection />
			</CatalogHostProvider>
		);
		expect(html).not.toContain(
			'aria-label="Install the Mattpocock Skills pack"'
		);
	});

	test("opened pack reveals its member skills", () => {
		const opened: SkillPackDetail = {
			...pack,
			members: [
				{ id: "mattpocock/skills/caveman", installed: true, name: "Caveman" },
				{ id: "mattpocock/skills/tdd", installed: false, name: "Tdd" },
			],
		};
		const html = render(
			makeSkillsState(),
			makePackState({ opened, opening: pack.id })
		);
		expect(html).toContain("Caveman");
		expect(html).toContain("Tdd");
	});

	test("empty packs render no shelf", () => {
		const html = render(makeSkillsState(), makePackState({ packs: [] }));
		expect(html).not.toContain("Skill packs");
	});
});

describe("pack / skill avatar helpers", () => {
	test("packAvatarUrl uses the repo owner", () => {
		expect(packAvatarUrl({ id: "mattpocock/skills" })).toBe(
			"https://github.com/mattpocock.png"
		);
		expect(packAvatarUrl({ id: "no-slash" })).toBeNull();
	});

	test("skillAvatarUrl uses the skill's source owner", () => {
		const card: SkillCard = {
			id: "vercel-labs/agent-skills/find-skills",
			installed: false,
			installs: 0,
			name: "Find Skills",
			slug: "find-skills",
			source: "vercel-labs/agent-skills",
		};
		expect(skillAvatarUrl(card)).toBe("https://github.com/vercel-labs.png");
	});
});
