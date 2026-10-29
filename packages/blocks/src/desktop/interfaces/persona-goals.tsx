import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import type { InterfaceSnapshot } from "@ryuhq/protocol/interfaces";
import { Plus } from "lucide-react";
import { motion } from "motion/react";
import { PersonaAvatar } from "./persona-avatar.tsx";
import type { PersonaGoal } from "./persona-model.ts";
import {
	EmptyNote,
	PageColumn,
	PageIntro,
	SectionLabel,
	ThreadLine,
} from "./persona-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

const MAX_GOAL_THREADS = 4;
const MAX_MEMBERS = 4;

function GoalProgress({
	answered,
	total,
}: {
	answered: number;
	total: number;
}) {
	const reduceMotion = useReducedMotion();
	const ratio = total === 0 ? 0 : answered / total;
	const tl = useLiteralMessages();
	return (
		<div
			aria-label="Answered conversations"
			aria-valuemax={total}
			aria-valuemin={0}
			aria-valuenow={answered}
			aria-valuetext={tl("{answered} of {total} answered", { answered, total })}
			className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
			role="progressbar"
		>
			<motion.div
				animate={{ scaleX: ratio }}
				className="h-full origin-left rounded-full bg-primary"
				initial={reduceMotion ? false : { scaleX: 0 }}
				transition={{ duration: reduceMotion ? 0 : 0.5, ease: [0.2, 0, 0, 1] }}
			/>
		</div>
	);
}

function GoalRow({
	goal,
	onNewChat,
	onOpen,
	snapshot,
}: {
	goal: PersonaGoal;
	onNewChat: (goal: PersonaGoal) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const members = goal.group.memberAgentIds
		.map((id) => snapshot.agents.find((agent) => agent.id === id))
		.filter((agent) => agent !== undefined);
	const shown = goal.threads.slice(0, MAX_GOAL_THREADS);
	const hidden = goal.threads.length - shown.length;
	const headingId = `persona-goal-${goal.group.id}`;
	const groupName = goal.group.name;
	const tl = useLiteralMessages();
	return (
		<li className="flex flex-col gap-3 py-5 first:pt-2">
			<div className="flex items-center gap-3">
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<h4 className="truncate font-medium text-base" id={headingId}>
						{goal.group.name}
					</h4>
					<p className="text-muted-foreground text-sm tabular-nums">
						{goal.total === 0
							? "No conversations yet"
							: tl("{answered} of {total} answered · {open} open", {
									answered: goal.answered,
									open: goal.open,
									total: goal.total,
								})}
					</p>
				</div>
				{members.length > 0 ? (
					<span
						aria-label={tl("Members: {names}", {
							names: members.map((agent) => agent.name).join(", "),
						})}
						className="flex shrink-0 -space-x-1.5"
						role="img"
					>
						{members.slice(0, MAX_MEMBERS).map((agent) => (
							<PersonaAvatar
								agent={agent}
								className="rounded-full ring-2 ring-background"
								key={agent.id}
								size={24}
							/>
						))}
					</span>
				) : null}
				<Button
					aria-label={tl("New chat in {name}", { name: groupName })}
					className="@max-[1023px]:size-8 shrink-0 @max-[1023px]:px-0"
					onClick={() => onNewChat(goal)}
					size="sm"
					title={tl("New chat in {name}", { name: groupName })}
					type="button"
					variant="outline"
				>
					<Plus aria-hidden="true" />
					<span className="@max-[1023px]:hidden">New chat</span>
				</Button>
			</div>
			<GoalProgress answered={goal.answered} total={goal.total} />
			{shown.length > 0 ? (
				<ul aria-labelledby={headingId} className="flex flex-col">
					{shown.map((thread) => (
						<ThreadLine key={thread.id} onOpen={onOpen} thread={thread} />
					))}
				</ul>
			) : null}
			{hidden > 0 ? (
				<p className="text-muted-foreground text-xs">
					{tl("{hidden} more", { hidden })}
				</p>
			) : null}
		</li>
	);
}

/**
 * Goals: projects and teams, each with how many of its conversations the
 * agents have answered (nothing pending on their side) and how many are open.
 */
export function PersonaGoals({
	goals,
	onNewChat,
	onOpen,
	snapshot,
}: {
	goals: { projects: PersonaGoal[]; teams: PersonaGoal[] };
	onNewChat: (goal: PersonaGoal) => void;
	onOpen: (threadId: string) => void;
	snapshot: InterfaceSnapshot;
}) {
	const sections = [
		{ goals: goals.projects, key: "projects", label: "Projects" },
		{ goals: goals.teams, key: "teams", label: "Teams" },
	].filter((section) => section.goals.length > 0);
	return (
		<PageColumn>
			<PageIntro id="persona-goals-title" title="Goals" />
			{sections.length === 0 ? (
				<EmptyNote>
					No projects or teams yet. Group conversations into a project to track
					it here.
				</EmptyNote>
			) : null}
			{sections.map((section) => (
				<section
					aria-labelledby={`persona-goals-${section.key}`}
					key={section.key}
				>
					<SectionLabel
						count={section.goals.length}
						id={`persona-goals-${section.key}`}
					>
						{section.label}
					</SectionLabel>
					<ul className="flex flex-col divide-y divide-border">
						{section.goals.map((goal) => (
							<GoalRow
								goal={goal}
								key={goal.group.id}
								onNewChat={onNewChat}
								onOpen={onOpen}
								snapshot={snapshot}
							/>
						))}
					</ul>
				</section>
			))}
		</PageColumn>
	);
}
