import { OnboardingView } from "@ryu/blocks/desktop/onboarding.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { OnboardingSkillPackOption } from "@/src/lib/api/onboarding-skills.ts";
import "../../src/index.css";

const PACKS: OnboardingSkillPackOption[] = [
	{
		description:
			"Interface design, typography, color, layout, accessibility, writing, and review skills.",
		id: "jakubkrehel/skills",
		name: "Jakubkrehel Skills",
	},
	{
		description:
			"TDD, code review, debugging, domain modeling and writing workflows.",
		id: "mattpocock/skills",
		name: "Matt Pocock Skills",
	},
	{
		description:
			"Official document skills for PDF, PPTX, XLSX, DOCX, sketch and brand workflows.",
		id: "anthropics/skills",
		name: "Anthropics Skills",
	},
	{
		description:
			"Curated React, Next.js, TypeScript, testing and performance best practices.",
		id: "vercel-labs/agent-skills",
		name: "Vercel Labs Agent Skills",
	},
	{
		description:
			"Architecture, testing, security, operations and product engineering skills.",
		id: "wshobson/agents",
		name: "Wshobson Agents",
	},
	{
		description:
			"Branded architecture, data, flow and security diagrams across common formats.",
		id: "cathrynlavery/diagram-design",
		name: "Cathryn Lavery Diagram Design",
	},
	{
		description:
			"Gate files, runnable checks, Depth Tree planning and proof-based completion.",
		id: "Leonxlnx/unlazy",
		name: "Leonxlnx Unlazy",
	},
	{
		description: "UI polish, animation taste and design-engineering craft.",
		id: "emilkowalski/skills",
		name: "Emil Kowalski Skills",
	},
	{
		description:
			"Brainstorming, planning and execution workflows for serious work.",
		id: "obra/superpowers",
		name: "Obra Superpowers",
	},
	{
		description: "Rewrite AI-sounding prose into natural, human writing.",
		id: "blader/humanizer",
		name: "Blader Humanizer",
	},
	{
		description: "Detect and remove AI-slop phrasing before text ships.",
		id: "petergyang/no-ai-slop",
		name: "No AI Slop",
	},
	{
		description:
			"Positioning, copy and go-to-market workflows for product teams.",
		id: "coreyhaines31/marketingskills",
		name: "Corey Haines Marketing Skills",
	},
	{
		description: "Threat modeling, security audits and secure-coding review.",
		id: "mukul975/Anthropic-Cybersecurity-Skills",
		name: "Anthropic Cybersecurity Skills",
	},
	{
		description:
			"Teach deeply from first principles with rigor and useful examples.",
		id: "multica-ai/andrej-karpathy-skills",
		name: "Andrej Karpathy Skills",
	},
	{
		description: "Google Workspace Drive, Gmail, Calendar and Docs workflows.",
		id: "googleworkspace/cli",
		name: "Google Workspace CLI",
	},
	{
		description:
			"A design-aware standard for judging and producing great work.",
		id: "Leonxlnx/taste-skill",
		name: "Taste Skill",
	},
	{
		description: "Review a product, codebase or business on its recent arc.",
		id: "mvanhorn/last30days-skill",
		name: "Last 30 Days",
	},
	{
		description: "Craft App Store and Play Store screenshots that sell.",
		id: "adamlyttleapps/claude-skill-aso-appstore-screenshots",
		name: "ASO App Store Screenshots",
	},
	{
		description:
			"Official Cursor skills for review, CI, debugging and workflows.",
		id: "cursor/plugins",
		name: "Cursor Plugins",
	},
	{
		description:
			"OpenAI skills for app development, verification and agent workflows.",
		id: "openai/plugins",
		name: "OpenAI Plugins",
	},
	{
		description:
			"Official Claude skills for agents, MCP apps, automation and plugins.",
		id: "anthropics/claude-plugins-official",
		name: "Claude Plugins Official",
	},
];

function ProofApp() {
	const [selected, setSelected] = useState(
		() => new Set(PACKS.map((pack) => pack.id))
	);
	const [saved, setSaved] = useState<string[] | null>(null);

	return (
		<div className="h-screen bg-background text-foreground">
			<OnboardingView
				onClearAllSkillPacks={() => setSelected(new Set())}
				onContinueSkillPacks={() => setSaved([...selected])}
				onSelectAllSkillPacks={() =>
					setSelected(new Set(PACKS.map((pack) => pack.id)))
				}
				onToggleSkillPack={(id) =>
					setSelected((previous) => {
						const next = new Set(previous);
						if (next.has(id)) {
							next.delete(id);
						} else {
							next.add(id);
						}
						return next;
					})
				}
				selectedSkillPackIds={selected}
				skillPacks={PACKS}
				skillPacksCanConfigure
				step="skills"
				subtitle="Select the optional skill collections to install on this node"
				title="Choose recommended skills"
			/>
			{saved ? (
				<div
					className="fixed right-6 bottom-6 rounded-2xl border border-success/30 bg-background/95 p-4 shadow-lg"
					data-testid="skills-selection-saved"
				>
					<p className="font-medium text-sm">Selection saved</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{saved.length} optional collections selected for this node.
					</p>
				</div>
			) : null}
		</div>
	);
}

createRoot(document.getElementById("root")!).render(<ProofApp />);
