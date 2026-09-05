import { ThemeProvider } from "next-themes";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PinnedAgentStage } from "../../src/components/layout/pinned-agent-stage.tsx";
import { AgentAvatar, engineForAgent } from "../../src/lib/agent-logos.tsx";
import type { AgentSummary } from "../../src/lib/api/agents.ts";
import "../../src/index.css";

function agent(id: string, name: string, engine: string): AgentSummary {
	return {
		avatarGlyph: null,
		avatarUrl: null,
		builtIn: true,
		createdAt: null,
		description: `${name} proof agent`,
		engine,
		id,
		installHint: null,
		installed: true,
		latestVersion: null,
		lifecycleStatus: "active",
		locked: false,
		model: null,
		name,
		recommended: false,
		safetyProfile: "autonomous",
		systemPrompt: null,
		title: "",
		transport: "acp",
		version: null,
		versionStatus: "unknown",
	};
}

const AGENTS = [
	agent("chief-of-staff", "Chief of staff", "ryu"),
	agent("personal", "Personal", "claude"),
	agent("amazon", "Amazon Bot", "gemini"),
	agent("computer", "Computer Helper", "codex"),
	agent("email", "Email Agent", "mistral"),
	agent("research", "Researcher", "grok-build"),
];

function OtherAgentRows({ agents }: { agents: AgentSummary[] }) {
	return (
		<div className="space-y-0.5 border-sidebar-border/70 border-t px-2 pt-2">
			<div className="px-1 pb-1 text-[10px] text-muted-foreground uppercase tracking-[0.1em]">
				Other agents
			</div>
			{agents.map((agent) => (
				<div
					className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-sidebar-accent"
					key={agent.id}
				>
					<AgentAvatar
						className="size-8 shrink-0 rounded-full object-cover"
						engine={engineForAgent(agent)}
						glyph={agent.avatarGlyph}
						size="32px"
					/>
					<span className="truncate">{agent.name}</span>
				</div>
			))}
		</div>
	);
}

function Preview({ count, label }: { count: number; label: string }) {
	const pinned = AGENTS.slice(0, count);
	const other = AGENTS.slice(count);
	const [unpinned, setUnpinned] = useState<string[]>([]);
	const visiblePinned = pinned.filter((agent) => !unpinned.includes(agent.id));

	return (
		<section className="space-y-3" data-testid={`pinned-preview-${count}`}>
			<header className="flex items-baseline justify-between px-1">
				<div>
					<h2 className="font-medium text-sm">{label}</h2>
					<p className="mt-0.5 text-muted-foreground text-xs">
						{count} pinned {count === 1 ? "bot" : "bots"}
					</p>
				</div>
				<span className="rounded-full bg-primary/10 px-2 py-1 font-medium text-primary text-xs">
					Agents
				</span>
			</header>
			<div className="overflow-hidden rounded-2xl border border-sidebar-border/80 bg-sidebar shadow-[0_12px_36px_-24px_black]">
				<div className="flex items-center justify-between border-sidebar-border/70 border-b px-4 py-3">
					<span className="font-semibold text-sm">Agents view</span>
					<span className="text-muted-foreground text-xs">
						Direct threads inline
					</span>
				</div>
				<div className="p-2.5">
					<PinnedAgentStage
						agents={visiblePinned}
						onEdit={() => undefined}
						onOpen={() => undefined}
						onUnpin={(agent) =>
							setUnpinned((current) => [...current, agent.id])
						}
					/>
					{other.length > 0 ? <OtherAgentRows agents={other} /> : null}
				</div>
			</div>
		</section>
	);
}

function Story() {
	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="dark"
			enableSystem={false}
			forcedTheme="dark"
		>
			<main className="min-h-screen bg-background px-6 py-10 text-foreground sm:px-10">
				<div className="mx-auto max-w-[1180px]">
					<header className="mb-8 max-w-2xl">
						<p className="font-medium text-primary text-xs uppercase tracking-[0.16em]">
							Ryu Work · Agents view
						</p>
						<h1 className="mt-2 font-semibold text-2xl tracking-tight">
							Pinned agents get the space they deserve
						</h1>
						<p className="mt-2 text-muted-foreground text-sm leading-6">
							The roster scales from one focused bot to a compact three-up shelf
							while ordinary agents stay available underneath.
						</p>
					</header>
					<div className="grid gap-8 lg:grid-cols-3">
						<Preview count={1} label="Hero" />
						<Preview count={2} label="Pair" />
						<Preview count={4} label="Three-up grid" />
					</div>
				</div>
			</main>
		</ThemeProvider>
	);
}

const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
