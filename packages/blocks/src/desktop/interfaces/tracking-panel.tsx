import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import { STAGE_TEXT } from "./tracking-list.tsx";
import {
	TRACKING_STAGE_LABELS,
	type TrackingParcel,
} from "./tracking-model.ts";

/**
 * The open conversation beside the tracking page: tracking number, item, and
 * stage over the host's real conversation surface. In narrower layouts it
 * covers the tracking page instead of squeezing it.
 */
export function TrackingThreadPanel({
	docked,
	headingRef,
	onClose,
	parcel,
	threadView,
}: {
	/** True when the panel sits beside the page rather than over it. */
	docked: boolean;
	headingRef: Ref<HTMLHeadingElement>;
	onClose: () => void;
	parcel: TrackingParcel | undefined;
	threadView: ReactNode;
}) {
	const reduceMotion = useReducedMotion();
	const tl = useLiteralMessages();
	const title = parcel
		? parcel.thread.title.trim() || "Untitled conversation"
		: "New parcel";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Conversation: {title}", { title })}
			className={cn(
				"flex min-h-0 flex-col bg-background",
				docked
					? "w-[clamp(24rem,36vw,38rem)] shrink-0 border-border border-l"
					: "absolute inset-0 z-20"
			)}
			data-testid="tracking-thread-panel"
			initial={reduceMotion ? false : { opacity: 0, x: 16 }}
			transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
		>
			<header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h2
						className="truncate font-medium text-foreground text-sm leading-5 outline-none"
						ref={headingRef}
						tabIndex={-1}
					>
						{title}
					</h2>
					<p className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs leading-4">
						{parcel ? (
							<>
								<span className="shrink-0 font-mono text-[11px] tracking-wide">
									{parcel.number}
								</span>
								<span aria-hidden="true">·</span>
								<span className={cn("truncate", STAGE_TEXT[parcel.stage])}>
									{TRACKING_STAGE_LABELS[parcel.stage]}
								</span>
							</>
						) : (
							<span>Not tracked yet</span>
						)}
					</p>
				</div>
				<Kbd aria-hidden="true" className="max-sm:hidden">
					Esc
				</Kbd>
				<Button
					aria-label="Close conversation"
					onClick={onClose}
					size="icon-sm"
					title="Close conversation (Esc)"
					type="button"
					variant="ghost"
				>
					<X aria-hidden="true" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">{threadView}</div>
		</motion.aside>
	);
}
