"use client";

import {
	Brain01Icon,
	Clock01Icon,
	LockedIcon,
	Message01Icon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@ryu/ui/components/badge";
import { Logo as RyuLogo } from "@ryu/ui/components/logo";
import { Separator } from "@ryu/ui/components/separator";
import type { ReactNode } from "react";

// ── Live preview card (ChatGPT/Notion-style agent summary) ─────────────────────

function PreviewChip({
	icon,
	children,
}: {
	icon: ReactNode;
	children: ReactNode;
}) {
	return (
		<span className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-muted/50 px-2.5 py-1 text-xs">
			<span className="shrink-0 text-muted-foreground">{icon}</span>
			<span className="truncate">{children}</span>
		</span>
	);
}

export interface AgentPreviewCardProps {
	builtIn: boolean;
	displayName: string;
	instructions: string;
	locked: boolean;
	modelLabel: string | null;
	name: string;
	scheduleSummary: string | null;
	toneLabel: string | null;
	tools: string[];
}

export function AgentPreviewCard({
	builtIn,
	displayName,
	instructions,
	locked,
	modelLabel,
	name,
	scheduleSummary,
	toneLabel,
	tools,
}: AgentPreviewCardProps) {
	const heading = displayName.trim() || name.trim() || "New agent";
	const subtitle =
		name.trim() && name.trim() !== heading ? name.trim() : "Agent";
	const hasMeta = Boolean(
		modelLabel || toneLabel || scheduleSummary || tools.length > 0
	);

	let badge: ReactNode = null;
	if (builtIn) {
		badge = (
			<Badge className="ml-auto shrink-0" variant="secondary">
				<HugeiconsIcon className="size-3" icon={LockedIcon} />
				Built-in
			</Badge>
		);
	} else if (locked) {
		badge = (
			<Badge className="ml-auto shrink-0" variant="secondary">
				<HugeiconsIcon className="size-3" icon={LockedIcon} />
				Locked
			</Badge>
		);
	}

	return (
		<div className="flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-sm">
			<div className="flex items-center gap-3">
				<div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted">
					<RyuLogo size="24px" tone="foreground" variant="outline" />
				</div>
				<div className="flex min-w-0 flex-col">
					<span className="truncate font-medium text-base leading-tight">
						{heading}
					</span>
					<span className="truncate text-muted-foreground text-xs">
						{subtitle}
					</span>
				</div>
				{badge}
			</div>

			{hasMeta ? (
				<div className="flex flex-wrap gap-1.5">
					{modelLabel ? (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Message01Icon} />}
						>
							{modelLabel}
						</PreviewChip>
					) : null}
					{toneLabel ? (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Brain01Icon} />}
						>
							{toneLabel}
						</PreviewChip>
					) : null}
					{scheduleSummary ? (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Clock01Icon} />}
						>
							{scheduleSummary}
						</PreviewChip>
					) : null}
					{tools.map((tool) => (
						<PreviewChip
							icon={<HugeiconsIcon className="size-3" icon={Wrench01Icon} />}
							key={tool}
						>
							{tool}
						</PreviewChip>
					))}
				</div>
			) : null}

			<Separator />

			<div className="flex flex-col gap-2">
				<span className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
					Instructions
				</span>
				{instructions.trim() ? (
					<div className="max-h-72 overflow-auto">
						<p className="whitespace-pre-wrap text-foreground/90 text-sm leading-relaxed">
							{instructions.trim()}
						</p>
					</div>
				) : (
					<p className="text-muted-foreground text-sm italic">
						No instructions yet. Describe how this agent should behave on the
						left.
					</p>
				)}
			</div>
		</div>
	);
}
