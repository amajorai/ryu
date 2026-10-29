import { PotionIcon } from "@hugeicons/core-free-icons";
import {
	LibraryToolbar,
	type LibraryViewMode,
} from "@ryu/blocks/desktop/library.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import SidebarLibrarySection from "../../src/components/library/SidebarLibrarySection.tsx";
import SkillRelationsGraph from "../../src/components/library/SkillRelationsGraph.tsx";
import type { InstalledSkill } from "../../src/lib/api/skills.ts";
import type { SkillRelationAgent } from "../../src/lib/skill-relations.ts";
import "../../src/index.css";

const SKILLS: InstalledSkill[] = [
	{
		allowedTools: ["browser.search", "files.read"],
		description: "Searches the web and gathers cited evidence.",
		enabled: true,
		id: "research",
		name: "Research",
	},
	{
		allowedTools: ["files.read", "files.write"],
		description: "Turns source material into concise documents.",
		enabled: true,
		id: "drafting",
		name: "Drafting",
	},
	{
		allowedTools: ["browser.search"],
		description: "An installed skill waiting for activation.",
		enabled: false,
		id: "fact-check",
		name: "Fact check",
	},
];

const AGENTS: SkillRelationAgent[] = [
	{
		description: "The default Ryu agent.",
		id: "ryu",
		name: "Ryu",
		skills: [],
	},
	{
		description: "A writing-focused agent.",
		id: "writer",
		name: "Writer",
		skills: ["drafting", "research"],
	},
];

const USAGE = new Map([
	["research", 14],
	["drafting", 6],
]);

const SHELF_ITEMS = SKILLS.map((skill) => ({
	icon: PotionIcon,
	id: skill.id,
	name: skill.name,
	onOpen: () => undefined,
	subtitle: skill.description,
}));

function Story() {
	const [query, setQuery] = useState("");
	const [view, setView] = useState<LibraryViewMode>("grid");

	return (
		<main className="min-h-screen bg-background px-6 py-8 text-foreground">
			<div className="mx-auto flex max-w-5xl flex-col gap-5">
				<header className="flex flex-wrap items-start justify-between gap-4">
					<div>
						<p className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
							Library · Skills
						</p>
						<h1 className="mt-1 font-semibold text-2xl">Installed skills</h1>
						<p className="mt-1 max-w-xl text-muted-foreground text-sm">
							Browse the bookshelf or see how agents, skills, and declared tools
							connect.
						</p>
					</div>
					<div data-testid="skill-relations-toggle">
						<LibraryToolbar
							onViewChange={setView}
							showGraph
							showSearch={false}
							view={view}
						/>
					</div>
				</header>
				{view === "graph" ? (
					<div className="flex flex-col gap-3">
						<Input
							aria-label="Search relations"
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search relations…"
							value={query}
						/>
						<SkillRelationsGraph
							agents={AGENTS}
							onOpenCatalog={() => undefined}
							query={query}
							skills={SKILLS}
							usage={USAGE}
							usageAvailable
						/>
					</div>
				) : (
					<section
						aria-label="Skills bookshelf"
						className="rounded-2xl border p-5"
					>
						<SidebarLibrarySection
							icon={PotionIcon}
							items={SHELF_ITEMS}
							label="Skills"
							query=""
							variant="books"
							view="grid"
						/>
					</section>
				)}
			</div>
		</main>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
