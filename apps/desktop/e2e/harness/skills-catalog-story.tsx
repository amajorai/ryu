import proofStyles from "./skills-catalog-story.module.css";
// Standalone browser story for the REAL shared `SkillsCatalogSection` — the one
// desktop and web both mount — driven by a fake `CatalogHost` whose `select`
// behaves exactly like a shipping host's: it stores whatever id it is handed.
//
// Why a browser story rather than a unit test: the preview is a PORTALED dialog,
// which `renderToStaticMarkup` never emits (the section's unit tests say so), so
// "the preview closes" is only observable in a real DOM. The regression it pins:
// the layout asked `selectedId != null`, and closing the preview calls
// `select("")` — a value that is not null. The dialog therefore re-opened itself
// on close, with nothing selected to render ("No skill selected") and no click
// able to dismiss it.
//
// The only stub is the host (no Core here). Everything between it and the pixels
// — section, layout, dialog — is the shipping code.

import {
	type CatalogHost,
	CatalogHostProvider,
} from "@ryu/marketplace/catalog/host";
import type { SkillPacksState } from "@ryu/marketplace/catalog/pack-types";
import SkillsCatalogSection from "@ryu/marketplace/catalog/skills";
import type {
	SkillCard,
	SkillCatalogSource,
	SkillDetail,
	SkillsCatalogState,
} from "@ryu/marketplace/catalog/types";
import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../src/index.css";

const SKILLS: SkillCard[] = [
	{
		catalogSourceId: "skills-sh",
		catalogSourceName: "skills.sh",
		id: "acme/repo/pdf-filler",
		installed: false,
		installs: 1200,
		name: "PDF Filler",
		slug: "pdf-filler",
		source: "skills.sh",
		trustLevel: "community",
	},
	{
		catalogSourceId: "skills-sh",
		catalogSourceName: "skills.sh",
		id: "acme/repo/csv-tidy",
		installed: false,
		installs: 40,
		name: "CSV Tidy",
		slug: "csv-tidy",
		source: "skills.sh",
		trustLevel: "community",
	},
	{
		catalogSourceId: "browse-sh",
		catalogSourceName: "browse.sh",
		id: "browse.sh/web-search",
		installed: false,
		installs: 980,
		name: "Web Search",
		slug: "web-search",
		source: "browse.sh",
		trustLevel: "trusted",
	},
	{
		catalogSourceId: "clawhub",
		catalogSourceName: "ClawHub",
		id: "clawhub/skill-auditor",
		installed: false,
		installs: 760,
		name: "Skill Auditor",
		slug: "skill-auditor",
		source: "ClawHub",
		trustLevel: "community",
	},
	{
		catalogSourceId: "lobehub",
		catalogSourceName: "LobeHub",
		id: "lobehub/lateral-thinking",
		installed: false,
		installs: 430,
		name: "Lateral Thinking",
		slug: "lateral-thinking",
		source: "LobeHub",
		trustLevel: "community",
	},
	{
		catalogSourceId: "ryu-marketplace",
		catalogSourceName: "Ryu Marketplace",
		id: "ryu/meeting-notes",
		installed: false,
		installs: 210,
		name: "Meeting Notes",
		slug: "meeting-notes",
		source: "Ryu Marketplace",
		trustLevel: "builtin",
	},
];

function detailFor(id: string): SkillDetail | null {
	const card = SKILLS.find((s) => s.id === id);
	if (!card) {
		return null;
	}
	return {
		card,
		description: "A skill.",
		files: [{ path: "SKILL.md" }],
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
		readme: `# ${card.name}\n\nA skill.`,
		url: `https://skills.sh/${card.slug}`,
	};
}

const NOOP = () => undefined;
const NOOP_ASYNC = () => Promise.resolve();
const NOOP_INSTALL = async () => [];

const STORY_SKILL_PACKS: SkillPacksState = {
	error: null,
	install: NOOP_INSTALL,
	installing: null,
	loading: false,
	open: NOOP,
	opened: null,
	opening: null,
	packs: [
		{
			builtin: true,
			description:
				"Interface design, typography, color, layout, accessibility, writing, and review skills.",
			id: "jakubkrehel/skills",
			memberCount: 11,
			name: "Jakubkrehel Skills",
		},
		{
			builtin: true,
			description:
				"TDD, code review, debugging, domain modeling, and writing workflows.",
			id: "mattpocock/skills",
			memberCount: 8,
			name: "Mattpocock Skills",
		},
		{
			builtin: true,
			description:
				"Official document skills for PDF, PowerPoint, spreadsheets, and Word.",
			id: "anthropics/skills",
			memberCount: 4,
			name: "Anthropic Skills",
		},
		{
			builtin: true,
			description:
				"React, Next.js, TypeScript, testing, and performance best practices.",
			id: "vercel-labs/agent-skills",
			memberCount: 5,
			name: "Vercel Agent Skills",
		},
	],
	refresh: NOOP,
};

/** A host whose `select` stores the raw id — including the empty string the
 *  layout sends on close. Normalising it here would hide the very bug this story
 *  exists to catch. */
function useStorySkillsCatalog(): SkillsCatalogState {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [sources, setSources] = useState<SkillCatalogSource[]>([
		{ builtin: true, displayName: "skills.sh", id: "skills-sh" },
		{ builtin: true, displayName: "browse.sh", id: "browse-sh" },
		{ builtin: true, displayName: "ClawHub", id: "clawhub" },
		{ builtin: true, displayName: "LobeHub", id: "lobehub" },
		{
			builtin: true,
			displayName: "Ryu Marketplace",
			id: "ryu-marketplace",
		},
		{ builtin: false, displayName: "Team Skills", id: "team-skills" },
		{ builtin: false, displayName: "Research Lab", id: "research-lab" },
	]);
	const select = useCallback((id: string) => setSelectedId(id), []);
	const addMarketplace = useCallback(
		async (params: { id: string; displayName: string }) => {
			setSources((current) => [
				...current,
				{ builtin: false, displayName: params.displayName, id: params.id },
			]);
		},
		[]
	);
	const removeMarketplace = useCallback(async (id: string) => {
		setSources((current) => current.filter((source) => source.id !== id));
	}, []);
	const reorderMarketplace = useCallback(
		async (id: string, direction: "up" | "down") => {
			setSources((current) => {
				const customIndexes = current.flatMap((source, index) =>
					source.builtin ? [] : [index]
				);
				const currentIndex = customIndexes.find(
					(index) => current[index]?.id === id
				);
				if (currentIndex === undefined) {
					return current;
				}
				const customPosition = customIndexes.indexOf(currentIndex);
				const targetPosition = customPosition + (direction === "up" ? -1 : 1);
				const targetIndex = customIndexes[targetPosition];
				if (targetIndex === undefined) {
					return current;
				}
				const next = [...current];
				[next[currentIndex], next[targetIndex]] = [
					next[targetIndex],
					next[currentIndex],
				];
				return next;
			});
		},
		[]
	);
	return {
		activeSource: "all",
		addingMarketplace: false,
		addMarketplace,
		detail: selectedId ? detailFor(selectedId) : null,
		detailError: null,
		detailLoading: false,
		enabledByKey: {},
		error: null,
		fetchNextPage: NOOP,
		hasNextPage: false,
		install: NOOP_ASYNC,
		installedOnly: false,
		installing: null,
		loading: false,
		org: "",
		query: "",
		select,
		selectedId,
		selectingSource: false,
		selectSource: NOOP,
		removeMarketplace,
		reorderMarketplace,
		setInstalledOnly: NOOP,
		setOrg: NOOP,
		setQuery: NOOP,
		setSkillEnabled: NOOP_ASYNC,
		setSort: NOOP,
		skills: SKILLS,
		sort: "popular",
		sources,
		togglingSkill: null,
	};
}

const host: CatalogHost = {
	install: {
		InstallButton: ({ children }) => <button type="button">{children}</button>,
	},
	Markdown: ({ content }) => <div>{content}</div>,
	openExternal: NOOP,
	renderAffordance: (target) => <span>Open {target.name} in Ryu</span>,
	useAppsCatalog: () => {
		throw new Error("unused");
	},
	useSkillsCatalog: useStorySkillsCatalog,
	useSkillPacks: () => STORY_SKILL_PACKS,
	useModelCatalog: () => {
		throw new Error("unused");
	},
	useActiveNode: () => ({ url: "", token: null }),
	usePersistedToggle: (_k: string, d: boolean) => [d, NOOP],
	installSidecar: NOOP_ASYNC,
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

function Story() {
	return (
		<div className={proofStyles.fixture1}>
			<CatalogHostProvider host={host}>
				<SkillsCatalogSection />
			</CatalogHostProvider>
		</div>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
