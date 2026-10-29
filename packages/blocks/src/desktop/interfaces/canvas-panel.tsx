import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { THREAD_STATUS_LABELS } from "@ryuhq/protocol/interfaces";
import { LocateFixed, X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { isTypingTarget } from "./canvas-hooks.ts";
import type { CanvasCardModel } from "./canvas-model.ts";
import { useReducedMotion } from "./reduced-motion.ts";

function PanelButton({
	children,
	hint,
	label,
	onClick,
}: {
	children: ReactNode;
	hint?: string;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<Button
						aria-label={label}
						onClick={onClick}
						size="icon-sm"
						type="button"
						variant="ghost"
					/>
				}
			>
				{children}
			</TooltipTrigger>
			<TooltipContent side="bottom">
				{label}
				{hint ? <Kbd>{hint}</Kbd> : null}
			</TooltipContent>
		</Tooltip>
	);
}

/**
 * The open thread docked on the right of the canvas: a slim header over the
 * host's real conversation surface. Narrow windows cover the canvas instead.
 */
export function CanvasThreadPanel({
	card,
	onClose,
	onLocate,
	overlay,
	threadView,
}: {
	card: CanvasCardModel | undefined;
	onClose: () => void;
	onLocate: (() => void) | undefined;
	overlay: boolean;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = card
		? card.thread.title.trim() || "Untitled thread"
		: "New thread";
	const lead = card?.lead;
	const offset = reduceMotion ? 0 : 24;
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {title}", { title })}
			className={cn(
				"flex min-h-0 flex-col bg-background outline-none",
				overlay
					? "absolute inset-0 z-40"
					: "relative w-[clamp(360px,40%,720px)] shrink-0 border-border border-l shadow-[-16px_0_32px_-24px] shadow-foreground/30"
			)}
			data-canvas-keeps-selection=""
			data-testid="canvas-thread-panel"
			exit={{ opacity: 0, x: offset }}
			initial={{ opacity: 0, x: offset }}
			// Escape closes the thread from anywhere in the panel, except while
			// typing (the host composer keeps its own Escape) or once the host
			// chat has handled it.
			onKeyDown={(event) => {
				if (
					event.key === "Escape" &&
					!event.defaultPrevented &&
					!isTypingTarget(event.target)
				) {
					event.preventDefault();
					onClose();
				}
			}}
			// A click anywhere in the panel focuses it, so Escape reaches it.
			tabIndex={-1}
			transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.2, 0, 0, 1] }}
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-3">
				{lead ? <BoardAvatar agent={lead} name={lead.name} size={28} /> : null}
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2 className="truncate font-semibold text-foreground text-sm leading-tight">
						<span className="font-semibold">{title}</span>
					</h2>
					{card ? (
						<span className="flex min-w-0 items-center gap-1.5 text-foreground/75 text-xs leading-tight">
							<span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-foreground">
								<BoardStatusDot status={card.status} />
								{THREAD_STATUS_LABELS[card.status]}
							</span>
							{card.agents.length > 0 ? (
								<>
									<span aria-hidden="true">·</span>
									<span className="truncate">
										{card.agents.map((agent) => agent.name).join(", ")}
									</span>
								</>
							) : null}
						</span>
					) : (
						<span className="text-foreground/75 text-xs leading-tight">
							Starting…
						</span>
					)}
				</div>
				{onLocate ? (
					<PanelButton label="Show on canvas" onClick={onLocate}>
						<LocateFixed aria-hidden="true" />
					</PanelButton>
				) : null}
				<PanelButton hint="Esc" label="Close thread" onClick={onClose}>
					<X aria-hidden="true" />
				</PanelButton>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
