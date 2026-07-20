"use client";

import {
	AiBrain01Icon,
	EyeIcon,
	Wrench01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip";
import { cn } from "@ryu/ui/lib/utils";
import { memo } from "react";

/**
 * The active agent's capabilities, used to gate which composer affordances show.
 * Mirrors Core's `CapabilityReport` (the effective, post-override flags).
 */
export interface AgentCapabilities {
	reasoning: boolean;
	tools: boolean;
	vision: boolean;
}

interface Badge {
	icon: typeof Wrench01Icon;
	key: keyof AgentCapabilities;
	label: string;
}

const BADGES: Badge[] = [
	{ key: "tools", icon: Wrench01Icon, label: "Can use tools" },
	{ key: "reasoning", icon: AiBrain01Icon, label: "Supports thinking" },
	{ key: "vision", icon: EyeIcon, label: "Accepts images" },
];

/**
 * A compact, read-only row of capability icons (tools / thinking / vision) for
 * the active agent — Ryu's analogue of Jan's `Capabilities` badges. Only the
 * supported capabilities render, so the composer reflects, at a glance, what the
 * selected agent can actually do. Meaningful for local models (capabilities
 * detected from the GGUF chat template) and the flagship Ryu; the composer hides
 * this row for external ACP harnesses (Claude Code, Codex, Gemini CLI, …), where
 * the badges would be noise (see `composer-agent-controls.tsx`).
 * Renders nothing when the agent supports none — keeping the toolbar clean.
 */
export const CapabilityBadges = memo(function CapabilityBadges({
	capabilities,
	className,
}: {
	capabilities: AgentCapabilities | null;
	className?: string;
}) {
	if (!capabilities) {
		return null;
	}
	const active = BADGES.filter((b) => capabilities[b.key]);
	if (active.length === 0) {
		return null;
	}
	return (
		<div className={cn("flex items-center gap-0.5", className)}>
			{active.map((badge) => (
				<Tooltip key={badge.key}>
					<TooltipTrigger
						render={
							<span
								aria-label={badge.label}
								className="flex size-5 items-center justify-center rounded text-muted-foreground/70"
								role="img"
							/>
						}
					>
						<HugeiconsIcon icon={badge.icon} size={14} />
					</TooltipTrigger>
					<TooltipContent>{badge.label}</TooltipContent>
				</Tooltip>
			))}
		</div>
	);
});
