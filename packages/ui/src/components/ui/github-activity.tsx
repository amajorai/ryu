"use client";

import { cn } from "@ryu/ui/lib/utils";
import {
	AnimatePresence,
	motion,
	type Transition,
	useReducedMotion,
} from "motion/react";
import * as React from "react";
import { createPortal } from "react-dom";

export type ContributionLevel = 0 | 1 | 2 | 3 | 4;

export interface Contribution {
	count: number;
	date: string;
	level: ContributionLevel;
}

export interface RepoContribution {
	count: number;
	href?: string;
	logo?: React.ReactNode;
	name: string;
}

const DEFAULT_ACCENT = "var(--primary)";
const DEFAULT_CELL_SIZE = 11;
const DEFAULT_LABEL = "Top contributions in:";
const DEFAULT_MONTHS = 12;
const WEEKS_PER_MONTH = 365.25 / 12 / 7;
const STACK_LIMIT = 3;
const MIN_CARD_WIDTH = 320;
const MIN_LABEL_WEEKS = 3;
// the p-4 on the card, both sides; the width math below has to add it back
const CARD_PADDING = 32;

export interface ContributionUnit {
	plural: string;
	singular: string;
}

const DEFAULT_UNIT = {
	plural: "contributions",
	singular: "contribution",
} as const satisfies ContributionUnit;

const gapFor = (cellSize: number) => Math.max(2, Math.round(cellSize / 4));
// never zero: weeks.slice(-0) would hand back the whole history instead of nothing
const weeksFor = (months: number) =>
	Math.max(1, Math.ceil(months * WEEKS_PER_MONTH));

const useIsoLayoutEffect =
	typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

const EASE_OUT = [0.22, 1, 0.36, 1] as const;
const SPRING = { type: "spring", bounce: 0.2, duration: 0.62 } as const;
const HEADER_SPRING = { ...SPRING, bounce: 0.45 } as const;
const ROW_SPRING = { ...SPRING, bounce: 0.26, delay: 0.08 } as const;
const ROW_OFFSET = 16;
const CELL_FADE = { duration: 0.2, ease: EASE_OUT } as const;
const TOOLTIP_FADE = { duration: 0.14, ease: EASE_OUT } as const;
const TOOLTIP_EDGE = 8;
const COLUMN_STAGGER = 0.012;
const LABEL_BLUR = 6;
const LABEL_REVEAL = { duration: 0.45, ease: EASE_OUT } as const;

const LEVELS = [0, 1, 2, 3, 4] as const;

const MONTH_NAMES = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function toMonthLabels(weeks: Contribution[][]) {
	const labels: (string | null)[] = weeks.map(() => null);
	const monthAt = (index: number) => weeks[index]?.[0]?.date.slice(5, 7);

	let start = 0;
	for (let i = 1; i <= weeks.length; i++) {
		if (i < weeks.length && monthAt(i) === monthAt(start)) {
			continue;
		}
		// a shorter run is narrower than the label itself, so it would sit under the next month
		if (i - start >= MIN_LABEL_WEEKS) {
			labels[start] = MONTH_NAMES[Number(monthAt(start)) - 1] ?? null;
		}
		start = i;
	}

	return labels;
}

const LEVEL_OPACITY: Record<ContributionLevel, number> = {
	0: 0,
	1: 0.3,
	2: 0.52,
	3: 0.76,
	4: 1,
};

interface LevelStyle {
	backgroundColor: string;
	opacity: number;
}

interface HoveredDay {
	day: Contribution;
	x: number;
	y: number;
}

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
});

function describeDay({ count, date }: Contribution, unit: ContributionUnit) {
	const label = count === 1 ? unit.singular : unit.plural;
	return `${count} ${label} on ${DATE_FORMAT.format(new Date(`${date}T00:00:00`))}`;
}

const CALENDAR_API = "https://github-contributions-api.jogruber.de/v4";
const EVENTS_API = "https://api.github.com/users";

interface ApiDay {
	count: number;
	date: string;
	level: number;
}

interface PushEvent {
	payload?: { commits?: unknown[] };
	repo?: { name: string };
	type: string;
}

async function fetchCalendar(login: string) {
	const res = await fetch(`${CALENDAR_API}/${login}?y=last`);
	if (!res.ok) {
		return null;
	}

	const days: ApiDay[] = (await res.json())?.contributions ?? [];
	if (!days.length) {
		return null;
	}

	// columns are weeks, so the first day has to be a sunday or every column shears
	const start = days.findIndex(
		(day) => new Date(`${day.date}T00:00:00Z`).getUTCDay() === 0
	);

	return days.slice(start < 0 ? 0 : start).map<Contribution>((day) => ({
		date: day.date,
		count: day.count,
		level: Math.min(4, Math.max(0, day.level)) as ContributionLevel,
	}));
}

async function fetchRepos(login: string): Promise<RepoContribution[]> {
	const res = await fetch(`${EVENTS_API}/${login}/events/public?per_page=100`);
	if (!res.ok) {
		return [];
	}

	const events: PushEvent[] = await res.json();
	const counts = new Map<string, number>();

	for (const event of events) {
		if (event.type !== "PushEvent" || !event.repo) {
			continue;
		}
		const commits = event.payload?.commits?.length ?? 1;
		counts.set(event.repo.name, (counts.get(event.repo.name) ?? 0) + commits);
	}

	return [...counts.entries()]
		.sort(([, a], [, b]) => b - a)
		.slice(0, STACK_LIMIT)
		.map(([fullName, count]) => {
			const separator = fullName.indexOf("/");
			const owner = separator >= 0 ? fullName.slice(0, separator) : "";
			const name = separator >= 0 ? fullName.slice(separator + 1) : fullName;
			return {
				name,
				count,
				href: `https://github.com/${fullName}`,
				// github has no repo logo, only an owner avatar, so own repos use the initial
				logo:
					owner.toLowerCase() === login.toLowerCase() ? undefined : (
						// eslint-disable-next-line @next/next/no-img-element
						<img alt="" src={`https://github.com/${owner}.png?size=64`} />
					),
			};
		});
}

function useGitHubUser(login?: string) {
	const [data, setData] = React.useState<{
		contributions: Contribution[];
		repos: RepoContribution[];
	}>();

	React.useEffect(() => {
		if (!login) {
			return;
		}
		let active = true;

		Promise.all([fetchCalendar(login), fetchRepos(login)])
			.then(([contributions, repos]) => {
				if (active && contributions) {
					setData({ contributions, repos });
				}
			})
			.catch(() => {});

		return () => {
			active = false;
		};
	}, [login]);

	return data;
}

function emptyDays(weeks: number): Contribution[] {
	const today = new Date();
	return Array.from({ length: weeks * 7 }, (_, i) => {
		const date = new Date(today);
		date.setDate(date.getDate() - (weeks * 7 - 1 - i));
		return {
			date: date.toISOString().slice(0, 10),
			count: 0,
			level: 0 as ContributionLevel,
		};
	});
}

function toScale(accent: string | string[]): LevelStyle[] {
	if (typeof accent === "string") {
		return LEVELS.map((level) => ({
			backgroundColor: accent,
			opacity: LEVEL_OPACITY[level],
		}));
	}

	const colors = accent.length > 4 ? accent : ["transparent", ...accent];
	return LEVELS.map((level) => {
		const color = colors[level] ?? colors.at(-1) ?? "transparent";
		return { backgroundColor: color, opacity: color === "transparent" ? 0 : 1 };
	});
}

function toWeeks(contributions: Contribution[]) {
	const weeks: Contribution[][] = [];
	for (let i = 0; i < contributions.length; i += 7) {
		weeks.push(contributions.slice(i, i + 7));
	}
	return weeks;
}

function useFittedColumns(cellSize: number, gap: number) {
	const ref = React.useRef<HTMLDivElement>(null);
	const [columns, setColumns] = React.useState<number>();

	useIsoLayoutEffect(() => {
		const el = ref.current;
		if (!el) {
			return;
		}

		const measure = () =>
			setColumns(
				Math.max(1, Math.floor((el.clientWidth + gap) / (cellSize + gap)))
			);

		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [cellSize, gap]);

	return [ref, columns] as const;
}

const Tooltip = ({
	hovered,
	reduceMotion,
	unit,
}: {
	hovered: HoveredDay;
	reduceMotion: boolean | null;
	unit: ContributionUnit;
}) => {
	const ref = React.useRef<HTMLDivElement>(null);
	const [left, setLeft] = React.useState(hovered.x);

	useIsoLayoutEffect(() => {
		const half = (ref.current?.offsetWidth ?? 0) / 2;
		const edge = TOOLTIP_EDGE + half;
		setLeft(Math.min(Math.max(hovered.x, edge), window.innerWidth - edge));
	}, [hovered]);

	return createPortal(
		<div
			className="pointer-events-none fixed z-50"
			style={{
				left,
				top: hovered.y,
				transform: "translate(-50%, calc(-100% - 8px))",
			}}
		>
			<motion.div
				animate={{ opacity: 1, scale: 1 }}
				className="whitespace-nowrap rounded-lg bg-foreground px-2 py-1 font-medium text-[11px] text-background shadow-md"
				exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.94 }}
				initial={reduceMotion ? false : { opacity: 0, scale: 0.94 }}
				ref={ref}
				transition={reduceMotion ? { duration: 0 } : TOOLTIP_FADE}
			>
				{describeDay(hovered.day, unit)}
			</motion.div>
		</div>,
		document.body
	);
};

const ContributionGrid = ({
	contributions,
	scale,
	cellSize,
	months,
	showMonths,
	label,
	reduceMotion,
	unit,
}: {
	contributions: Contribution[];
	scale: LevelStyle[];
	cellSize: number;
	months: number;
	showMonths: boolean;
	label: string;
	reduceMotion: boolean | null;
	unit: ContributionUnit;
}) => {
	const weeks = React.useMemo(() => toWeeks(contributions), [contributions]);
	const gap = gapFor(cellSize);
	const [ref, columns] = useFittedColumns(cellSize, gap);
	const [hovered, setHovered] = React.useState<HoveredDay>();

	const cap = Math.min(weeks.length, weeksFor(months));
	const visible = weeks.slice(-Math.min(cap, columns ?? cap));
	const sweepEnd = (visible.length - 1) * COLUMN_STAGGER + CELL_FADE.duration;

	const hover = (day: Contribution) => (event: React.PointerEvent) => {
		const cell = event.currentTarget.getBoundingClientRect();
		setHovered({ day, x: cell.left + cell.width / 2, y: cell.top });
	};

	return (
		<div
			aria-label={label}
			className="relative"
			data-slot="github-activity-grid"
			ref={ref}
			role="img"
		>
			{showMonths && (
				<motion.div
					animate={{ opacity: 1, filter: "blur(0px)" }}
					className="flex justify-center"
					initial={
						reduceMotion
							? false
							: { opacity: 0, filter: `blur(${LABEL_BLUR}px)` }
					}
					style={{ gap, marginBottom: gap }}
					transition={{
						...LABEL_REVEAL,
						delay: reduceMotion ? 0 : sweepEnd,
					}}
				>
					{toMonthLabels(visible).map((month, index) => (
						<div
							className="relative h-3 shrink-0"
							key={index}
							style={{ width: cellSize }}
						>
							{month && (
								<span className="absolute top-0 left-0 text-[10px] text-foreground/40 leading-none">
									{month}
								</span>
							)}
						</div>
					))}
				</motion.div>
			)}

			<div
				className="flex justify-center overflow-hidden"
				onPointerLeave={() => setHovered(undefined)}
				style={{ gap }}
			>
				{visible.map((week, weekIndex) => (
					<div className="flex flex-col" key={weekIndex} style={{ gap }}>
						{week.map((day) => (
							<motion.div
								animate={{ opacity: 1, scale: 1 }}
								className="shrink-0 rounded-[3px] bg-foreground/[0.08]"
								initial={reduceMotion ? false : { opacity: 0, scale: 0.4 }}
								key={day.date}
								onPointerEnter={hover(day)}
								style={{ width: cellSize, height: cellSize }}
								transition={{
									...CELL_FADE,
									delay: reduceMotion ? 0 : weekIndex * COLUMN_STAGGER,
								}}
							>
								<div
									className="h-full w-full rounded-[3px]"
									style={scale[day.level] ?? scale[0]}
								/>
							</motion.div>
						))}
					</div>
				))}
			</div>

			<AnimatePresence>
				{hovered && (
					<Tooltip
						hovered={hovered}
						key="tooltip"
						reduceMotion={reduceMotion}
						unit={unit}
					/>
				)}
			</AnimatePresence>
		</div>
	);
};

const Avatar = ({
	repo,
	layoutId,
	transition,
	className,
}: {
	repo: RepoContribution;
	layoutId: string;
	transition: Transition;
	className?: string;
}) => (
	<motion.span
		className={cn(
			"grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-muted font-medium text-[11px] text-muted-foreground uppercase ring-2 ring-background",
			"[&_img]:size-full [&_img]:object-cover [&_svg]:size-full",
			className
		)}
		layoutId={layoutId}
		transition={transition}
	>
		{repo.logo ?? repo.name.charAt(0)}
	</motion.span>
);

const RepoRow = ({
	repo,
	layoutId,
	transition,
}: {
	repo: RepoContribution;
	layoutId: string;
	transition: Transition;
}) => {
	const className =
		"flex items-center gap-3 rounded-xl mx-2 px-2 py-2 transition-colors hover:bg-foreground/5";

	const content = (
		<>
			<Avatar layoutId={layoutId} repo={repo} transition={transition} />
			<span className="flex-1 truncate text-foreground text-sm">
				{repo.name}
			</span>
			<span className="text-foreground/70 text-sm tabular-nums">
				{repo.count}
			</span>
		</>
	);

	return repo.href ? (
		<a className={className} href={repo.href} rel="noopener" target="_blank">
			{content}
		</a>
	) : (
		<div className={className}>{content}</div>
	);
};

const Chevron = ({
	open,
	transition,
}: {
	open: boolean;
	transition: Transition;
}) => (
	<motion.svg
		animate={{ rotate: open ? 180 : 0 }}
		aria-hidden
		className="size-7 text-muted-foreground"
		fill="none"
		initial={false}
		stroke="currentColor"
		strokeLinecap="round"
		strokeLinejoin="round"
		strokeWidth="1.5"
		transition={transition}
		viewBox="0 0 24 24"
	>
		<circle cx="12" cy="12" r="10" />
		<path d="m16 10-4 4-4-4" />
	</motion.svg>
);

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
	const heading = `${total} ${unit.plural}${displayYear ? ` in ${displayYear}` : ""}`;

	const gap = gapFor(cellSize);
	const columns = Math.min(
		Math.ceil(contributions.length / 7),
		weeksFor(months)
	);
	const width = Math.max(
		MIN_CARD_WIDTH,
		columns * (cellSize + gap) - gap + CARD_PADDING
	);

	return (
		<div
			className={cn(
				"relative max-w-full overflow-hidden rounded-[28px] bg-card p-4 text-card-foreground",
				repos.length > 0 && "pb-[76px]",
				className
			)}
			data-slot="github-activity"
			style={{ width, ...style }}
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
					className={cn(
						"absolute inset-x-3 bottom-3 overflow-hidden bg-card/90 backdrop-blur-xl",
						open && "top-3"
					)}
					data-slot="github-activity-panel"
					data-state={open ? "open" : "closed"}
					id={`${uid}-panel`}
					layout
					style={{ borderRadius: 18 }}
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
								<div className="flex items-center">
									{repos.slice(0, STACK_LIMIT).map((repo, index) => (
										<Avatar
											className="-ml-2 first:ml-0"
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
