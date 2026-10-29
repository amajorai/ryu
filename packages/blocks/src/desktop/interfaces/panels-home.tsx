import { Button } from "@ryu/ui/components/button.tsx";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { motion } from "motion/react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentById, compactAge } from "./interface-renderer.ts";
import {
	buildPanelsActions,
	longDate,
	type PanelsAction,
	type PanelsTarget,
	panelHeaderActions,
	panelsGreeting,
	panelsSummary,
	shortClock,
	summarySentence,
} from "./panels-model.ts";
import { PANELS_EASE } from "./panels-parts.tsx";
import { PanelsSky } from "./panels-sky.tsx";
import {
	ActivityPanel,
	AgentsPanel,
	PanelsSkeleton,
	UpcomingPanel,
	WorkingPanel,
} from "./panels-widgets.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

/**
 * One suggestion card on the sky. The sentence reads as plain text, but its
 * verb is the real button (with the whole sentence as its accessible name),
 * and its hit area stretches over the card so the card is one tap target.
 */
function ActionCard({
	action,
	now,
	onTarget,
	snapshot,
}: {
	action: PanelsAction;
	now: number;
	onTarget: (target: PanelsTarget) => void;
	snapshot: InterfaceSnapshot;
}) {
	const agent = agentById(snapshot, action.agentId);
	const age = action.updatedAt ? compactAge(action.updatedAt, now) : null;
	return (
		<li
			className="group/card relative flex flex-col gap-3 rounded-lg border border-foreground/8 bg-background/80 p-4 backdrop-blur-md transition-colors duration-150 focus-within:border-ring hover:border-foreground/15 hover:bg-background/95"
			data-action-kind={action.kind}
		>
			<div className="flex h-6 items-center justify-between gap-2">
				<BoardAvatar
					agent={agent}
					className="ring-1 ring-foreground/10"
					name={agent?.name ?? action.sentence}
					size={24}
				/>
				{age ? (
					<span className="flex items-center gap-2 text-muted-foreground text-xs tabular-nums">
						{action.kind === "retry" ? (
							<span
								aria-hidden="true"
								className="size-1.5 rounded-full bg-destructive"
							/>
						) : null}
						{age}
					</span>
				) : null}
			</div>
			<div className="flex flex-col gap-2">
				<p className="line-clamp-3 text-base text-foreground/70 leading-snug">
					<button
						aria-label={action.sentence}
						className="rounded-sm font-semibold text-foreground underline decoration-foreground/0 underline-offset-4 outline-none transition-colors after:absolute after:inset-0 after:rounded-lg focus-visible:decoration-foreground/40 group-hover/card:decoration-foreground/40"
						data-testid="panels-action-verb"
						onClick={() => onTarget(action.target)}
						type="button"
					>
						{action.verb}
					</button>{" "}
					{action.rest}
					{action.subject ? (
						<>
							{" "}
							<span className="font-medium text-foreground">
								{action.subject}
							</span>
						</>
					) : null}
				</p>
				{action.detail ? (
					<p className="line-clamp-2 text-muted-foreground text-sm">
						{action.detail}
					</p>
				) : null}
			</div>
		</li>
	);
}

function ActionsSkeleton() {
	return (
		<ul
			aria-hidden="true"
			className="grid @5xl:grid-cols-4 @xl:grid-cols-2 gap-3"
		>
			{[0, 1, 2, 3].map((key) => (
				<li
					className="flex flex-col gap-3 rounded-lg border border-foreground/10 bg-background/60 p-4"
					key={key}
				>
					<Skeleton className="size-6" radius="pill" />
					<Skeleton className="h-4 w-4/5" radius="dense" />
					<Skeleton className="h-4 w-3/5" radius="dense" />
					<Skeleton className="mt-1 h-3 w-2/3" radius="dense" />
				</li>
			))}
		</ul>
	);
}

/**
 * Home: a calm control page over a sky for the local time of day. A greeting
 * and one sentence of status, then up to four one-tap suggestions, then the
 * panels grid: working now, upcoming runs, agents, recent activity.
 */
export function PanelsHome({
	loading,
	now,
	onNewChat,
	onTarget,
	snapshot,
}: {
	loading: boolean;
	now: Date;
	onNewChat: () => void;
	onTarget: (target: PanelsTarget) => void;
	snapshot: InterfaceSnapshot;
}) {
	const reduceMotion = useReducedMotion();
	const actions = buildPanelsActions(snapshot);
	const nowMs = now.getTime();
	const rise = (index: number) =>
		reduceMotion
			? {}
			: {
					animate: { opacity: 1, y: 0 },
					initial: { opacity: 0, y: 8 },
					transition: { delay: index * 0.06, duration: 0.4, ease: PANELS_EASE },
				};
	const panelProps = { now: nowMs, onTarget, snapshot };
	const headerActions = panelHeaderActions(snapshot, nowMs);
	return (
		<div className="@container min-h-full" data-testid="panels-home">
			<div className="relative">
				<PanelsSky now={now} />
				<div className="relative mx-auto flex w-full max-w-[66rem] flex-col gap-10 @2xl:px-8 px-4 @2xl:pt-16 pt-12">
					<motion.header className="flex flex-col gap-2" {...rise(0)}>
						<p className="font-medium text-foreground/70 text-sm tabular-nums">
							<time dateTime={now.toISOString()}>
								{longDate(now)} · {shortClock(now)}
							</time>
						</p>
						<h1 className="font-semibold text-[2rem] text-foreground leading-tight tracking-tight">
							{panelsGreeting(now)}
						</h1>
						{loading ? (
							<Skeleton className="mt-1 h-4 w-72" radius="dense" />
						) : (
							<p
								className="text-base text-foreground/75"
								data-testid="panels-summary"
							>
								{summarySentence(panelsSummary(snapshot))}
							</p>
						)}
					</motion.header>
					<motion.section aria-label="Suggestions" {...rise(1)}>
						{loading ? <ActionsSkeleton /> : null}
						{!loading && actions.length > 0 ? (
							<ul
								className="grid @5xl:grid-cols-4 @xl:grid-cols-2 gap-3"
								data-testid="panels-actions"
							>
								{actions.map((action) => (
									<ActionCard
										action={action}
										key={action.id}
										now={nowMs}
										onTarget={onTarget}
										snapshot={snapshot}
									/>
								))}
							</ul>
						) : null}
						{!loading && actions.length === 0 ? (
							<div
								className="flex @xl:flex-row flex-col items-start @xl:items-center @xl:justify-between gap-4 rounded-lg border border-foreground/10 bg-background/70 p-6 backdrop-blur-md"
								data-testid="panels-actions-empty"
							>
								<div className="flex flex-col gap-1">
									<p className="font-medium text-foreground text-sm">
										Nothing to act on
									</p>
									<p className="text-muted-foreground text-sm">
										Suggestions appear here when an agent replies, finishes, or
										needs a retry.
									</p>
								</div>
								<Button
									onClick={onNewChat}
									size="sm"
									type="button"
									variant="outline"
								>
									New chat
								</Button>
							</div>
						) : null}
					</motion.section>
				</div>
			</div>
			<div className="mx-auto w-full max-w-[66rem] @2xl:px-8 px-4 pt-14 pb-16">
				<motion.div {...rise(2)}>
					{loading ? (
						<PanelsSkeleton />
					) : (
						<div
							className="grid @3xl:grid-cols-2 items-start gap-x-12 gap-y-12"
							data-testid="panels-grid"
						>
							<div className="flex min-w-0 flex-col gap-12">
								<WorkingPanel action={headerActions.working} {...panelProps} />
								<AgentsPanel action={headerActions.agents} {...panelProps} />
							</div>
							<div className="flex min-w-0 flex-col gap-12">
								<UpcomingPanel
									action={headerActions.upcoming}
									{...panelProps}
								/>
								<ActivityPanel
									action={headerActions.activity}
									{...panelProps}
								/>
							</div>
						</div>
					)}
				</motion.div>
			</div>
		</div>
	);
}
