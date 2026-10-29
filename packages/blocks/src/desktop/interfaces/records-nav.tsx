import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	Bot,
	FolderKanban,
	ListFilter,
	type LucideIcon,
	UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import {
	RECORDS_OBJECT_LABELS,
	RECORDS_OBJECTS,
	RECORDS_VIEWS,
	type RecordsObject,
} from "./records-model.ts";

export const RECORDS_OBJECT_ICONS: Record<RecordsObject, LucideIcon> = {
	agents: Bot,
	projects: FolderKanban,
	teams: UsersRound,
};

function NavItem({
	active,
	count,
	icon: Icon,
	label,
	loading,
	onSelect,
}: {
	active: boolean;
	count: number;
	icon: LucideIcon;
	label: string;
	loading: boolean;
	onSelect: () => void;
}) {
	return (
		<li>
			<button
				aria-current={active ? "page" : undefined}
				className={cn(
					"group flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
					active
						? "bg-muted font-medium text-foreground"
						: "text-foreground/80 hover:bg-muted/60 hover:text-foreground"
				)}
				onClick={onSelect}
				type="button"
			>
				<Icon
					aria-hidden="true"
					className={cn(
						"size-4 shrink-0",
						active ? "text-foreground" : "text-muted-foreground"
					)}
				/>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{loading ? (
					<Skeleton className="h-3 w-4" />
				) : (
					<span className="text-muted-foreground text-xs tabular-nums">
						{count}
						<span className="sr-only"> records</span>
					</span>
				)}
			</button>
		</li>
	);
}

function NavSection({
	children,
	label,
}: {
	children: ReactNode;
	label: string;
}) {
	return (
		<section aria-label={label} className="flex flex-col gap-1">
			<h3 className="px-2 text-muted-foreground text-xs leading-6">{label}</h3>
			<ul className="flex flex-col gap-px">{children}</ul>
		</section>
	);
}

/**
 * The left rail: the three record objects, then saved views. A view is an
 * object with a filter and a sort, so picking one lands on that object.
 */
export function RecordsNav({
	activeViewId,
	counts,
	loading,
	object,
	onSelectObject,
	onSelectView,
	viewCounts,
}: {
	activeViewId: string | null;
	counts: Record<RecordsObject, number>;
	loading: boolean;
	object: RecordsObject;
	onSelectObject: (object: RecordsObject) => void;
	onSelectView: (viewId: string) => void;
	viewCounts: Record<string, number>;
}) {
	return (
		<nav
			aria-label="Records"
			className="flex w-56 shrink-0 flex-col border-border border-r bg-muted/30"
		>
			<div className="flex h-12 shrink-0 items-center border-border border-b px-4">
				<h2 className="text-foreground text-sm">
					<span className="font-semibold">Records</span>
				</h2>
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-2 py-3">
				<NavSection label="Objects">
					{RECORDS_OBJECTS.map((option) => (
						<NavItem
							active={activeViewId === null && object === option}
							count={counts[option]}
							icon={RECORDS_OBJECT_ICONS[option]}
							key={option}
							label={RECORDS_OBJECT_LABELS[option].plural}
							loading={loading}
							onSelect={() => onSelectObject(option)}
						/>
					))}
				</NavSection>
				<NavSection label="Views">
					{RECORDS_VIEWS.map((view) => (
						<NavItem
							active={activeViewId === view.id}
							count={viewCounts[view.id] ?? 0}
							icon={ListFilter}
							key={view.id}
							label={view.label}
							loading={loading}
							onSelect={() => onSelectView(view.id)}
						/>
					))}
				</NavSection>
			</div>
		</nav>
	);
}
