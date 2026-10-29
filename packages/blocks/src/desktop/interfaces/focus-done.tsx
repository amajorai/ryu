import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { useId } from "react";
import { InterfaceComposer } from "./interface-composer.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const EASE = [0.22, 1, 0.36, 1] as const;

function caughtUpDetail({
	agentCount,
	tl,
	total,
	working,
}: {
	agentCount: number;
	tl: LiteralMessage;
	total: number;
	working: number;
}): string {
	if (total === 0) {
		return agentCount === 0
			? "No threads and no agents yet. Start a thread and Ryu picks an agent."
			: "No threads need you. Start something new below.";
	}
	const seen =
		total === 1
			? "You've seen the only thread."
			: tl("You've seen all {totalText} threads.", {
					totalText: String(total),
				});
	if (working === 0) {
		return seen;
	}
	return tl(
		"{seen} {working, plural, one {{workingText} is} other {{workingText} are}} still running.",
		{ seen, working, workingText: String(working) }
	);
}

/**
 * The end of the queue: a calm confirmation and the one useful next step,
 * starting something new. Submitting the composer is the explicit action that
 * lets the host send the prompt.
 */
export function FocusDone({
	agents,
	onBackToTop,
	onStart,
	total,
	working,
}: {
	agents: InterfaceAgent[];
	onBackToTop: (() => void) | null;
	onStart: (input: { agentId?: string; prompt: string }) => void;
	total: number;
	working: number;
}) {
	const tl = useLiteralMessages();
	const titleId = useId();
	const reduceMotion = useReducedMotion();
	return (
		<motion.section
			animate={{ opacity: 1, y: 0 }}
			aria-labelledby={titleId}
			className="flex w-full flex-col"
			data-testid="focus-done"
			initial={{ opacity: 0, y: reduceMotion ? 0 : 8 }}
			transition={{ duration: reduceMotion ? 0.12 : 0.3, ease: EASE }}
		>
			<h2
				className="text-balance font-semibold text-2xl text-foreground leading-tight tracking-tight sm:text-[1.875rem]"
				id={titleId}
			>
				You&apos;re caught up
			</h2>
			<p className="mt-3 text-pretty text-muted-foreground text-sm">
				{caughtUpDetail({ agentCount: agents.length, tl, total, working })}
				{onBackToTop ? (
					<>
						{" "}
						<button
							className="rounded-sm text-foreground underline decoration-muted-foreground/40 underline-offset-4 outline-none transition-[text-decoration-color] hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
							onClick={onBackToTop}
							type="button"
						>
							Start over
						</button>
					</>
				) : null}
			</p>
			<div className="mt-8">
				<InterfaceComposer
					agents={agents}
					label="Start something new"
					onSubmit={onStart}
					placeholder="Start something new…"
					submitLabel="Start"
				/>
			</div>
		</motion.section>
	);
}
