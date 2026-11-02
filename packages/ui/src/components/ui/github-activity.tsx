"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { MotionStyle } from "motion/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { CSSProperties } from "react";
import * as React from "react";
import drawingStyles from "./github-activity.drawing.module.css";
import { ContributionGrid, drawingLength } from "./github-activity-grid.tsx";
import {
	type Contribution,
	type ContributionUnit,
	contributionHeading,
	DEFAULT_UNIT,
	emptyDays,
	gapFor,
	type RepoContribution,
	toScale,
	weeksFor,
} from "./github-activity-model.ts";
import {
	Avatar,
	Chevron,
	RepoRow,
	STACK_LIMIT,
	useGitHubUser,
} from "./github-activity-repos.tsx";

interface ActivityCardStyle extends CSSProperties {
	"--github-activity-7-width"?: string | undefined;
}
interface ActivityPanelStyle extends MotionStyle {
	"--github-activity-8-border-radius"?: string | undefined;
}

export type {
	Contribution,
	ContributionLevel,
	ContributionUnit,
	RepoContribution,
} from "./github-activity-model.ts";

const DEFAULT_ACCENT = "var(--primary)";
const DEFAULT_CELL_SIZE = 11;
const DEFAULT_LABEL = "Top contributions in:";
const DEFAULT_MONTHS = 12;
const MIN_CARD_WIDTH = 320;
// the p-4 on the card, both sides; the width math below has to add it back
const CARD_PADDING = 32;
const ACTIVITY_PANEL_RADIUS = 18;

const SPRING = { type: "spring", bounce: 0.2, duration: 0.62 } as const;
const HEADER_SPRING = { ...SPRING, bounce: 0.45 } as const;
const ROW_SPRING = { ...SPRING, bounce: 0.26, delay: 0.08 } as const;
const ROW_OFFSET = 16;

export type GitHubActivityProps = React.ComponentProps<"div"> & {
	username?: string;
	contributions?: Contribution[];
	repos?: RepoContribution[];
	year?: number;
	accent?: string | string[];
	cellSize?: number;
	months?: number;
	showMonths?: boolean;
	label?: string;
	unit?: ContributionUnit;
	defaultOpen?: boolean;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
};

const GitHubActivity = ({
	className,
	username,
	contributions: contributionsProp = [],
	repos: reposProp = [],
	year,
	accent = DEFAULT_ACCENT,
	cellSize = DEFAULT_CELL_SIZE,
	months = DEFAULT_MONTHS,
	showMonths = false,
	label = DEFAULT_LABEL,
	unit = DEFAULT_UNIT,
	defaultOpen = false,
	open: openProp,
	onOpenChange,
	style,
	...props
}: GitHubActivityProps) => {
	const reduceMotion = useReducedMotion();
	const tl = useLiteralMessages();
	const uid = React.useId();
	const [openState, setOpenState] = React.useState(defaultOpen);

	const open = openProp ?? openState;
	const toggle = () => {
		if (openProp === undefined) {
			setOpenState(!open);
		}
		onOpenChange?.(!open);
	};

	const shouldFetch =
		Boolean(username) && !(contributionsProp.length && reposProp.length);
	const fetched = useGitHubUser(shouldFetch ? username : undefined);
	const placeholder = React.useMemo(
		() => (username ? emptyDays(weeksFor(months)) : []),
		[username, months]
	);

	const contributions = contributionsProp.length
		? contributionsProp
		: (fetched?.contributions ?? placeholder);
	const repos = reposProp.length ? reposProp : (fetched?.repos ?? []);

	const scale = React.useMemo(() => toScale(accent), [accent]);
	const transition = reduceMotion ? { duration: 0 } : SPRING;
	const headerTransition = reduceMotion ? { duration: 0 } : HEADER_SPRING;
	const rowTransition = reduceMotion ? { duration: 0 } : ROW_SPRING;

	const kick = reduceMotion ? {} : { x: ROW_OFFSET, y: ROW_OFFSET };
	const listMotion = {
		initial: { opacity: 0, ...kick },
		animate: { opacity: 1, x: 0, y: 0 },
		exit: { opacity: 0, ...kick },
	};

	const total = React.useMemo(
		() => contributions.reduce((sum, day) => sum + day.count, 0),
		[contributions]
	);

	const parsedYear = Number(contributions.at(-1)?.date.slice(0, 4));
	const displayYear = year ?? (Number.isFinite(parsedYear) ? parsedYear : null);
	const heading = contributionHeading(total, unit, displayYear, tl);

	const gap = gapFor(cellSize);
	const columns = Math.min(
		Math.ceil(contributions.length / 7),
		weeksFor(months)
	);
	const width = Math.max(
		MIN_CARD_WIDTH,
		columns * (cellSize + gap) - gap + CARD_PADDING
	);

	const activityCardStyle: ActivityCardStyle = {
		"--github-activity-7-width": drawingLength(width),
		...style,
	};
	const activityPanelStyle: ActivityPanelStyle = {
		"--github-activity-8-border-radius": drawingLength(ACTIVITY_PANEL_RADIUS),
	};
	return (
		<div
			className={cn(
				cn(
					"relative max-w-full overflow-hidden rounded-[28px] bg-card p-4 text-card-foreground",
					repos.length > 0 && "pb-[76px]",
					className
				),
				drawingStyles.activityCard
			)}
			data-slot="github-activity"
			style={activityCardStyle}
			{...props}
		>
			<p className="mb-4 px-1.5 font-medium text-base text-foreground">
				{heading}
			</p>

			<ContributionGrid
				cellSize={cellSize}
				contributions={contributions}
				label={heading}
				months={months}
				reduceMotion={reduceMotion}
				scale={scale}
				showMonths={showMonths}
				unit={unit}
			/>

			{repos.length > 0 && (
				<motion.div
					// Motion scale-corrects only radii it owns, so hand the radius to it
					// through `animate`; the module rule remains the static fallback.
					animate={{ borderRadius: ACTIVITY_PANEL_RADIUS }}
					className={cn(
						cn(
							"absolute inset-x-3 bottom-3 overflow-hidden bg-card/90 backdrop-blur-xl",
							open && "top-3"
						),
						drawingStyles.activityPanel
					)}
					data-slot="github-activity-panel"
					data-state={open ? "open" : "closed"}
					id={`${uid}-panel`}
					initial={false}
					layout
					style={activityPanelStyle}
					transition={transition}
				>
					<motion.div
						className="flex items-center justify-between gap-3 px-4 py-3"
						layout="position"
						transition={headerTransition}
					>
						<span className="truncate text-foreground text-sm">{label}</span>

						<div className="flex items-center gap-3">
							{!open && (
								<div
									className="flex items-center [--avatar-overlap:--spacing(2)] [--avatar-size:--spacing(7)]"
									data-avatar-stack=""
								>
									{repos.slice(0, STACK_LIMIT).map((repo, index) => (
										<Avatar
											className="-ms-2 first:ms-0"
											key={index}
											layoutId={`${uid}-${index}`}
											repo={repo}
											transition={transition}
										/>
									))}
								</div>
							)}

							<button
								aria-controls={`${uid}-panel`}
								aria-expanded={open}
								aria-label={
									open ? "Hide top repositories" : "Show top repositories"
								}
								className="grid size-7 shrink-0 place-items-center rounded-full bg-card"
								onClick={toggle}
								type="button"
							>
								<Chevron open={open} transition={transition} />
							</button>
						</div>
					</motion.div>

					<AnimatePresence initial={false} mode="popLayout">
						{open && (
							<motion.ul
								key="list"
								layout="position"
								{...listMotion}
								className="px-0.5 pb-1"
								transition={rowTransition}
							>
								{repos.map((repo, index) => (
									<li key={index}>
										<RepoRow
											layoutId={`${uid}-${index}`}
											repo={repo}
											transition={transition}
										/>
									</li>
								))}
							</motion.ul>
						)}
					</AnimatePresence>
				</motion.div>
			)}
		</div>
	);
};

export { GitHubActivity };
export default GitHubActivity;
