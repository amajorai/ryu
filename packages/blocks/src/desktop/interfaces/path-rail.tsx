import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Flame, Zap } from "lucide-react";
import { type CSSProperties, type ReactNode, useId } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { GAME_FOCUS, GAME_PLATE } from "./game-hud.tsx";
import { PathChest } from "./path-art.tsx";
import {
	PATH_DAILY_GOAL,
	type PathLeader,
	type PathStats,
} from "./path-model.ts";

/** A small progress ring for the daily goal. */
export function PathGoalRing({
	className,
	goal,
	value,
}: {
	className?: string;
	goal: number;
	value: number;
}) {
	const progress = Math.min(1, goal > 0 ? value / goal : 0);
	if (progress >= 1) {
		return (
			<span
				aria-hidden="true"
				className={cn(
					"flex items-center justify-center rounded-full bg-primary text-primary-foreground",
					className
				)}
			>
				<Check className="size-[70%]" strokeWidth={4} />
			</span>
		);
	}
	return (
		<svg
			aria-hidden="true"
			className={cn("-rotate-90", className)}
			viewBox="0 0 36 36"
		>
			<circle
				className="fill-none stroke-muted"
				cx="18"
				cy="18"
				r="14"
				strokeWidth="5"
			/>
			{progress > 0 ? (
				<circle
					className="fill-none stroke-primary"
					cx="18"
					cy="18"
					pathLength="100"
					r="14"
					strokeDasharray={`${progress * 100} 100`}
					strokeLinecap="round"
					strokeWidth="5"
				/>
			) : null}
		</svg>
	);
}

function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** A HUD counter: an icon tile, a big number, and its label under it. */
const COUNTER =
	"flex h-full cursor-pointer items-center gap-2.5 py-2 ps-2.5 pe-4 outline-none transition-colors duration-100 first:rounded-s-[14px] last:rounded-e-[14px] hover:bg-(--gk-plate-sunk) aria-expanded:bg-(--gk-plate-sunk) @max-[719px]/game:gap-1.5 @max-[719px]/game:px-2 @max-[719px]/game:py-1.5";

const COUNTER_TILE =
	"grid size-10 shrink-0 place-items-center rounded-xl border-(--gk-edge) border-2 [&_svg]:size-5 @max-[719px]/game:size-7 @max-[719px]/game:[&_svg]:size-4";

/** A stat's popover: the rail card it summarizes, in the path's own type. */
function StatPopover({
	children,
	label,
	trigger,
}: {
	children: ReactNode;
	label: string;
	trigger: ReactNode;
}) {
	return (
		<Popover>
			<PopoverTrigger
				aria-label={label}
				className={cn(COUNTER, GAME_FOCUS)}
				type="button"
			>
				{trigger}
			</PopoverTrigger>
			<PopoverContent
				align="end"
				className="w-[360px] max-w-[calc(100vw-2rem)] border-2 border-border bg-background text-foreground shadow-lg backdrop-blur-none backdrop-saturate-100"
				corners="rounded"
				sideOffset={8}
				spacing="flush"
			>
				{children}
			</PopoverContent>
		</Popover>
	);
}

function CounterFace({
	icon,
	label,
	tile,
	value,
}: {
	icon: ReactNode;
	label: string;
	tile: string;
	value: ReactNode;
}) {
	return (
		<>
			<span aria-hidden="true" className={cn(COUNTER_TILE, tile)}>
				{icon}
			</span>
			<span aria-hidden="true" className="flex flex-col items-start">
				<span className="gk-display whitespace-nowrap @max-[719px]/game:text-[18px] text-[26px] tabular-nums @max-[719px]/game:leading-6 leading-7">
					{value}
				</span>
				<span className="@max-[719px]/game:hidden whitespace-nowrap font-semibold text-(--gk-ink-muted) text-[12px] uppercase leading-4 tracking-wide">
					{label}
				</span>
			</span>
		</>
	);
}

/**
 * Streak, XP, and the daily goal on one HUD plate. Each counter opens the
 * card behind it: the streak and goal open the goal card and XP opens the
 * leaderboard, so narrow stages without the rail still reach them.
 */
export function PathStatsBar({
	className,
	leaders,
	stats,
}: {
	className?: string;
	leaders: PathLeader[];
	stats: PathStats;
}) {
	const tl = useLiteralMessages();
	const goalMet = stats.repliedToday >= PATH_DAILY_GOAL;
	const capped = Math.min(stats.repliedToday, PATH_DAILY_GOAL);
	const streakDaysText = String(stats.streakDays);
	const xpText = stats.xp.toLocaleString("en-US");
	const goalCounts = {
		capped: String(capped),
		dailyGoal: String(PATH_DAILY_GOAL),
	};
	return (
		<ul
			aria-label="Your progress"
			className={cn(
				GAME_PLATE,
				"pointer-events-auto flex items-stretch divide-x-2 divide-(--gk-plate-sunk)",
				className
			)}
		>
			<li>
				<StatPopover
					label={tl(
						"Streak: {streakDays, plural, one {{streakDaysText} day} other {{streakDaysText} days}}. Show daily goal",
						{ streakDays: stats.streakDays, streakDaysText }
					)}
					trigger={
						<CounterFace
							icon={<Flame aria-hidden="true" strokeWidth={2.5} />}
							label="Day streak"
							tile={
								stats.streakDays > 0
									? "bg-(--gk-warn) text-(--gk-edge)"
									: "bg-(--gk-plate-sunk) text-(--gk-ink-muted)"
							}
							value={stats.streakDays}
						/>
					}
				>
					<GoalCard bare stats={stats} />
				</StatPopover>
			</li>
			<li>
				<StatPopover
					label={tl("{xp} XP. Show leaderboard", { xp: xpText })}
					trigger={
						<CounterFace
							icon={<Zap aria-hidden="true" strokeWidth={2.5} />}
							label="XP"
							tile="bg-(--gk-gold) text-(--gk-edge)"
							value={stats.xp.toLocaleString("en-US")}
						/>
					}
				>
					<Leaderboard bare leaders={leaders} />
				</StatPopover>
			</li>
			<li>
				<StatPopover
					label={tl(
						"Daily goal: {capped} of {dailyGoal} threads replied to today. Show daily goal",
						goalCounts
					)}
					trigger={
						<CounterFace
							icon={<Check aria-hidden="true" strokeWidth={3} />}
							label="Daily goal"
							tile={
								goalMet
									? "bg-(--gk-good) text-white"
									: "bg-(--gk-plate-sunk) text-(--gk-ink)"
							}
							value={`${capped}/${PATH_DAILY_GOAL}`}
						/>
					}
				>
					<GoalCard bare stats={stats} />
				</StatPopover>
			</li>
		</ul>
	);
}

/** A rail card: a HUD plate on the scene (the popover draws its own frame). */
function RailSection({
	bare = false,
	children,
	title,
	trailing,
}: {
	/** Inside a popover: the popover draws the outline. */
	bare?: boolean;
	children: ReactNode;
	title: string;
	trailing?: ReactNode;
}) {
	const headingId = useId();
	return (
		<section
			aria-labelledby={headingId}
			className={cn("p-5", !bare && cn(GAME_PLATE, "pointer-events-auto"))}
		>
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="gk-display text-[22px] leading-7" id={headingId}>
					{title}
				</h2>
				{trailing}
			</div>
			{children}
		</section>
	);
}

function GoalCard({
	bare = false,
	stats,
}: {
	bare?: boolean;
	stats: PathStats;
}) {
	const tl = useLiteralMessages();
	const capped = Math.min(stats.repliedToday, PATH_DAILY_GOAL);
	const met = stats.repliedToday >= PATH_DAILY_GOAL;
	return (
		<RailSection
			bare={bare}
			title="Daily goal"
			trailing={
				met ? (
					<span className="font-extrabold text-[13px] text-primary uppercase tracking-wider">
						Complete
					</span>
				) : null
			}
		>
			<div className="mt-4 flex items-center gap-4">
				<PathChest
					className="h-10 w-11 shrink-0"
					progress={capped / PATH_DAILY_GOAL}
				/>
				<div className="min-w-0 flex-1">
					<p className="font-bold text-[15px] leading-5">
						{tl("Reply to {dailyGoal} threads", {
							dailyGoal: String(PATH_DAILY_GOAL),
						})}
					</p>
					<div className="mt-2 flex items-center gap-3">
						<div
							aria-label={tl(
								"{capped} of {dailyGoal} threads replied to today",
								{
									capped: String(capped),
									dailyGoal: String(PATH_DAILY_GOAL),
								}
							)}
							aria-valuemax={PATH_DAILY_GOAL}
							aria-valuemin={0}
							aria-valuenow={capped}
							className="relative h-5 flex-1 overflow-hidden rounded-full bg-muted"
							role="progressbar"
						>
							<div
								className="h-full w-(--goal-progress) rounded-full bg-primary transition-all duration-500 ease-out motion-reduce:transition-none"
								// SAFETY: React's CSSProperties omits custom properties; the
								// value is a percentage string the width utility reads.
								style={
									{
										"--goal-progress": `${(capped / PATH_DAILY_GOAL) * 100}%`,
									} as CSSProperties
								}
							/>
						</div>
						<span
							aria-hidden="true"
							className="shrink-0 font-extrabold text-[13px] text-muted-foreground tabular-nums"
						>
							{capped} / {PATH_DAILY_GOAL}
						</span>
					</div>
				</div>
			</div>
			<div className="mt-5 border-border border-t-2 pt-4">
				<p className="flex items-center justify-between font-bold text-[15px] leading-5">
					<span>
						{tl("{streakDays} day streak", {
							streakDays: String(stats.streakDays),
						})}
					</span>
					<span className="font-medium text-[13px] text-muted-foreground">
						Last 7 days
					</span>
				</p>
				<ol
					aria-label="Outcomes in the last 7 days"
					className="mt-3 grid grid-cols-7 gap-1"
				>
					{stats.week.map((day) => (
						<li
							aria-label={`${day.key}${day.today ? " (today)" : ""}: ${day.active ? "an outcome" : "no outcome"}`}
							className="flex flex-col items-center gap-1.5"
							key={day.key}
						>
							<span
								aria-hidden="true"
								className={cn(
									"font-bold text-xs",
									day.today ? "text-foreground" : "text-muted-foreground"
								)}
							>
								{day.label}
							</span>
							<span
								aria-hidden="true"
								className={cn(
									"flex size-8 items-center justify-center rounded-full",
									day.active ? "bg-warning/15" : "bg-muted-foreground/15"
								)}
							>
								{day.active ? (
									<Flame className="size-[18px] fill-warning stroke-warning" />
								) : null}
							</span>
						</li>
					))}
				</ol>
			</div>
		</RailSection>
	);
}

/**
 * The top three wear medals like the reference's league table: gold in the
 * warning role, silver in muted foreground, bronze as warning turned toward
 * the destructive hue.
 */
const MEDALS: Record<number, string> = {
	1: "bg-warning text-warning-foreground",
	2: "bg-muted-foreground/25 text-foreground",
	3: "bg-[color-mix(in_oklch,var(--color-warning)_55%,var(--color-destructive))] text-background",
};

function Leaderboard({
	bare = false,
	leaders,
}: {
	bare?: boolean;
	leaders: PathLeader[];
}) {
	return (
		<RailSection
			bare={bare}
			title="Leaderboard"
			trailing={
				<span className="font-medium text-[13px] text-muted-foreground">
					By messages
				</span>
			}
		>
			{leaders.length === 0 ? (
				<p className="mt-3 text-[15px] text-muted-foreground leading-5">
					Agents show up here once they have threads.
				</p>
			) : (
				<ol className="-mx-2 mt-3 flex flex-col">
					{leaders.map((leader) => (
						<li
							className="flex h-14 items-center gap-3 rounded-xl px-2"
							key={leader.agent.id}
						>
							<span
								className={cn(
									"flex size-6 shrink-0 items-center justify-center rounded-full font-extrabold text-[13px] tabular-nums",
									MEDALS[leader.rank] ?? "text-muted-foreground"
								)}
							>
								{leader.rank}
							</span>
							<span className="relative shrink-0">
								<BoardAvatar
									agent={leader.agent}
									className="size-10"
									name={leader.agent.name}
									size={28}
								/>
								{leader.agent.status === "working" ? (
									<span
										aria-hidden="true"
										className="absolute -right-0.5 -bottom-0.5 size-3.5 rounded-full border-[3px] border-background bg-success"
									/>
								) : null}
							</span>
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate font-bold text-[15px] leading-5">
									{leader.agent.name}
								</span>
								<span
									className={cn(
										"truncate text-[13px] leading-4",
										leader.agent.status === "working"
											? "font-semibold text-status-success"
											: "text-muted-foreground"
									)}
								>
									{leader.agent.status === "working"
										? "Working now"
										: plural(leader.threads, "thread", "threads")}
								</span>
							</span>
							<span
								className={cn(
									"shrink-0 text-[15px] tabular-nums",
									leader.rank === 1
										? "font-extrabold text-foreground"
										: "font-semibold text-muted-foreground"
								)}
							>
								{leader.xp} XP
							</span>
						</li>
					))}
				</ol>
			)}
		</RailSection>
	);
}
