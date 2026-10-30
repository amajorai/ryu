import { cn } from "@ryu/ui/lib/utils.ts";
import type { GitGraphBranch, GitGraphRow } from "@/src/lib/git-graph.ts";

const LANE_COLORS = [
	"var(--primary)",
	"#60a5fa",
	"#f59e0b",
	"#e879f9",
	"#fb7185",
	"#2dd4bf",
] as const;

export function BranchRefRow({
	active,
	branch,
	label,
	onClick,
}: {
	active: boolean;
	branch?: GitGraphBranch;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			aria-current={active ? "page" : undefined}
			className={cn(
				"group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
				active
					? "bg-muted text-foreground"
					: "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
			)}
			onClick={onClick}
			type="button"
		>
			<span
				className={cn(
					"relative flex size-4 shrink-0 items-center justify-center rounded-full ring-1 ring-border/70",
					active && "ring-2 ring-primary/30"
				)}
			>
				<span
					className={cn(
						"size-1.5 rounded-full",
						active ? "bg-primary" : "bg-muted-foreground/50"
					)}
				/>
			</span>
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{branch?.current && (
				<span className="type-compact text-primary">HEAD</span>
			)}
		</button>
	);
}

export function GitGraphCommitRow({
	laneCount,
	onSelect,
	row,
	selected,
}: {
	laneCount: number;
	onSelect: () => void;
	row: GitGraphRow;
	selected: boolean;
}) {
	return (
		<button
			aria-pressed={selected}
			className={cn(
				"group flex min-h-14 w-full items-stretch rounded-lg text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
				selected && "bg-primary/[0.07]"
			)}
			onClick={onSelect}
			type="button"
		>
			<CommitLane laneCount={laneCount} row={row} selected={selected} />
			<span className="min-w-0 flex-1 py-2 pr-3">
				<span className="flex min-w-0 items-center gap-2">
					<span
						className={cn(
							"min-w-0 flex-1 truncate font-medium text-xs",
							selected && "text-foreground"
						)}
						title={row.commit.subject}
					>
						{row.commit.subject}
					</span>
					{row.commit.refs.slice(0, 3).map((ref) => (
						<span
							className="type-compact hidden shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-primary sm:inline"
							key={ref}
						>
							{ref}
						</span>
					))}
				</span>
				<span className="type-caption mt-1 flex items-center gap-1.5 truncate text-muted-foreground">
					<code className="font-mono text-foreground/70">
						{row.commit.shortSha}
					</code>
					<span aria-hidden="true">·</span>
					<span>{row.commit.author}</span>
					<span aria-hidden="true">·</span>
					<span>{row.commit.date}</span>
				</span>
			</span>
		</button>
	);
}

function CommitLane({
	laneCount,
	row,
	selected,
}: {
	laneCount: number;
	row: GitGraphRow;
	selected: boolean;
}) {
	const laneWidth = 22;
	const width = Math.max(48, laneCount * laneWidth + 18);
	const startX = row.lane * laneWidth + 10;
	return (
		<svg
			aria-hidden="true"
			className="h-14 shrink-0 overflow-visible"
			viewBox={`0 0 ${width} 56`}
			width={width}
		>
			{Array.from({ length: laneCount }, (_, lane) => {
				const x = lane * laneWidth + 10;
				return (
					<line
						key={`guide-${lane}`}
						opacity={lane === row.lane ? 0.35 : 0.12}
						stroke={laneColor(lane)}
						strokeWidth="1"
						x1={x}
						x2={x}
						y1="0"
						y2="56"
					/>
				);
			})}
			{row.parentLanes.map((parentLane, index) => {
				const endX = parentLane * laneWidth + 10;
				const path =
					endX === startX
						? `M ${startX} 28 L ${endX} 56`
						: `M ${startX} 28 C ${startX} 40, ${endX} 44, ${endX} 56`;
				return (
					<path
						className="transition-opacity"
						d={path}
						fill="none"
						key={`parent-${index}-${parentLane}`}
						opacity={0.85}
						stroke={laneColor(parentLane)}
						strokeLinecap="round"
						strokeWidth="1.5"
					/>
				);
			})}
			<circle
				cx={startX}
				cy="28"
				fill="var(--sidebar)"
				r={selected ? 5 : 4}
				stroke={laneColor(row.lane)}
				strokeWidth={selected ? 2 : 1.5}
			/>
		</svg>
	);
}

function laneColor(index: number): string {
	return LANE_COLORS[index % LANE_COLORS.length] ?? LANE_COLORS[0];
}
