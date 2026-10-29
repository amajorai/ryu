"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import type { CSSProperties } from "react";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";
import styles from "./works-with.module.css";

interface ToolMaskStyle extends CSSProperties {
	"--tool-mask": string;
}

interface Tool {
	href: string;
	logo?: string;
	name: string;
}

const TOOLS: Tool[] = [
	{
		name: "Claude Code",
		logo: "claude",
		href: "https://www.claude.com/product/claude-code",
	},
	{ name: "Codex", logo: "codex", href: "https://openai.com/codex" },
	{ name: "Gemini", logo: "gemini", href: "https://gemini.google.com" },
	{ name: "Cursor", logo: "cursor", href: "https://cursor.com" },
	{ name: "OpenAI", logo: "openai", href: "https://openai.com" },
	{ name: "OpenClaw", logo: "openclaw", href: "https://openclaw.ai" },
	{ name: "Ollama", logo: "ollama", href: "https://ollama.com" },
	{ name: "Hermes", href: "https://github.com/NousResearch/hermes-agent" },
	{ name: "Pi", href: "https://pi.dev" },
];

const MARQUEE_REPEAT = 4;

const MARQUEE_ITEMS = [
	...Array.from({ length: MARQUEE_REPEAT }, () => TOOLS).flat(),
	...Array.from({ length: MARQUEE_REPEAT }, () => TOOLS).flat(),
];

function Pill({ tool }: { tool: Tool }) {
	return (
		<a
			className="flex shrink-0 items-center gap-2.5 rounded-full bg-muted/50 px-5 py-2.5 transition-colors hover:bg-muted/70"
			href={tool.href}
			rel="noopener noreferrer"
			target="_blank"
		>
			{tool.logo ? (
				<span
					aria-hidden="true"
					className={`${styles.logo} size-5 shrink-0 bg-foreground/70`}
					style={
						{
							"--tool-mask": `url(/logos/${tool.logo}.svg)`,
						} satisfies ToolMaskStyle as ToolMaskStyle
					}
				/>
			) : null}
			<span className="whitespace-nowrap font-medium text-foreground/75 text-sm">
				{tool.name}
			</span>
		</a>
	);
}

export default function WorksWith() {
	return (
		<section className="py-16 md:py-20">
			<div className="container mx-auto px-4">
				<StaggerLines className="mx-auto max-w-5xl text-center">
					<SectionTitle title="Bring the agents you already use" />
					<p className={cn(sectionSubtitleClass, "max-w-5xl")}>
						Ryu is the interface and control layer for the agents, models,
						providers, and tools you already run.
					</p>
				</StaggerLines>
			</div>

			<div
				className={`${styles.viewport} group relative mt-10 w-full overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_4%,black_96%,transparent)]`}
			>
				<div className={`${styles.track} flex w-max gap-3`}>
					{MARQUEE_ITEMS.map((tool, i) => (
						<Pill key={`${tool.name}-${i}`} tool={tool} />
					))}
				</div>
			</div>
		</section>
	);
}
