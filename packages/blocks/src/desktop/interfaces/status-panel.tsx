import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceThread } from "@ryuhq/protocol/interfaces";
import { X } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { useReducedMotion } from "./reduced-motion.ts";
import { SEVERITY_TEXT } from "./status-incidents.tsx";
import type { StatusIncident } from "./status-model.ts";

/**
 * The open thread beside the status page: which incident it is (or just the
 * thread), who it affects, and a close control, over the host's real
 * conversation surface. Below `md` it covers the page rather than squeezing it.
 */
export function StatusThreadPanel({
	agentNames,
	headingRef,
	incident,
	onClose,
	thread,
	threadView,
}: {
	agentNames: readonly string[];
	headingRef: Ref<HTMLHeadingElement>;
	incident: StatusIncident | undefined;
	onClose: () => void;
	thread: InterfaceThread | undefined;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const title = thread
		? thread.title.trim() || "Untitled thread"
		: "New thread";
	const who =
		agentNames.length > 0 ? agentNames.join(", ") : "No agent assigned";
	return (
		<motion.aside
			animate={{ opacity: 1, x: 0 }}
			aria-label={tl("Thread: {threadTitle}", { threadTitle: title })}
			className="absolute inset-0 z-20 flex min-h-0 flex-col bg-background md:static md:w-[clamp(22rem,40vw,38rem)] md:shrink-0 md:border-border md:border-l"
			data-testid="status-thread-panel"
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
					<p className="truncate text-muted-foreground text-xs leading-4">
						{incident ? (
							<>
								<span
									className={cn(
										"font-medium",
										SEVERITY_TEXT[incident.severity]
									)}
								>
									{incident.stage}
								</span>
								<span aria-hidden="true"> · </span>
							</>
						) : null}
						{incident ? tl("Affects {agentNames}", { agentNames: who }) : who}
					</p>
				</div>
				<Kbd aria-hidden="true" className="max-sm:hidden">
					Esc
				</Kbd>
				<Button
					aria-label="Close thread"
					onClick={onClose}
					size="icon-sm"
					title="Close thread (Esc)"
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
