"use client";

// The Island's generative screen. Instead of stacking every `ui.render` card in
// the scrolling transcript, the island shows the agent's latest UI as ONE live
// surface above the chat: it morphs in when the agent renders, reshapes in place
// when a follow-up turn renders a replacement, and leaves when the conversation
// moves on or the user closes it. Which screen is live is decided by
// `deriveLiveAgentUiSurface`; this component only draws and animates it.

import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ComponentProps } from "react";
import { AgentUI } from "../../desktop/agent-elements/agent-ui/agent-ui.tsx";
import type { AgentUiSurface } from "../../desktop/agent-elements/agent-ui/surface.ts";

export interface IslandLiveSurfaceProps {
	className?: string;
	onDismiss: () => void;
	onSubmit?: ComponentProps<typeof AgentUI>["onSubmit"];
	/** The screen to show; `null` animates the current one out. */
	surface: AgentUiSurface | null;
	/** A follow-up turn is running and will replace this screen. */
	updating?: boolean;
}

const SURFACE_SPRING = {
	damping: 32,
	mass: 0.8,
	stiffness: 380,
	type: "spring" as const,
};

export function IslandLiveSurface({
	className,
	onDismiss,
	onSubmit,
	surface,
	updating = false,
}: IslandLiveSurfaceProps) {
	const reduceMotion = useReducedMotion();
	const hidden = reduceMotion
		? { opacity: 0 }
		: { opacity: 0, scale: 0.97, y: -6 };
	const shown = reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 };
	return (
		<AnimatePresence initial={!reduceMotion} mode="popLayout">
			{surface ? (
				<motion.section
					animate={shown}
					aria-busy={updating}
					aria-label={surface.title ?? "Generated screen"}
					className={cn(
						"relative flex min-h-0 shrink-0 flex-col overflow-hidden rounded-2xl border border-border bg-card",
						className
					)}
					data-slot="island-live-surface"
					exit={hidden}
					initial={hidden}
					key={surface.id}
					layout={!reduceMotion}
					transition={reduceMotion ? { duration: 0.12 } : SURFACE_SPRING}
				>
					<header className="flex h-10 shrink-0 items-center gap-2 px-3">
						<h3 className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
							{surface.title ?? "Generated screen"}
						</h3>
						{updating ? (
							<span
								aria-live="polite"
								className="shrink-0 animate-skeleton text-muted-foreground text-xs"
								role="status"
							>
								Updating…
							</span>
						) : null}
						<button
							aria-label="Close screen"
							className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
							onClick={onDismiss}
							title="Close screen"
							type="button"
						>
							<HugeiconsIcon
								aria-hidden
								className="size-3.5"
								icon={Cancel01Icon}
							/>
						</button>
					</header>
					<div
						className={cn(
							"min-h-0 overflow-y-auto px-3 pb-3 transition-opacity",
							updating && "opacity-60"
						)}
					>
						<AgentUI
							format={surface.format}
							onSubmit={onSubmit}
							spec={surface.spec}
						/>
					</div>
				</motion.section>
			) : null}
		</AnimatePresence>
	);
}
