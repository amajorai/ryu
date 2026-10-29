import { useLiteralMessages } from "@ryu/i18n/react";
import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { InterfaceAgent } from "@ryuhq/protocol/interfaces";
import {
	Folder,
	Hash,
	House,
	Newspaper,
	SquarePen,
	Users,
	X,
} from "lucide-react";
import type { ReactNode } from "react";
import { PostsAvatar } from "./posts-avatar.tsx";
import type { PostSpace, PostsView } from "./posts-model.ts";
import { viewKey } from "./posts-model.ts";

const ROW =
	"group/row flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-sidebar-ring";

/**
 * Active is a firm tint with full-strength text and icon; hover is half of
 * it, so the two never read as the same state. Tints come from the sidebar's
 * own foreground so they hold in every theme, light or dark.
 */
function rowTone(active: boolean): string {
	return active
		? "bg-sidebar-foreground/[0.08] font-medium text-sidebar-foreground [&_[data-row-icon]]:text-sidebar-foreground"
		: "text-sidebar-foreground/85 hover:bg-sidebar-foreground/[0.04] hover:text-sidebar-foreground";
}

function SidebarRow({
	active,
	ariaLabel,
	icon,
	label,
	onSelect,
	trailing,
}: {
	active: boolean;
	ariaLabel?: string;
	icon: ReactNode;
	label: string;
	onSelect: () => void;
	trailing?: ReactNode;
}) {
	return (
		<li>
			<button
				aria-current={active ? "page" : undefined}
				aria-label={ariaLabel}
				className={cn(ROW, rowTone(active))}
				onClick={onSelect}
				type="button"
			>
				<span
					className="flex size-5 shrink-0 items-center justify-center text-sidebar-foreground/60 [&_svg]:size-4"
					data-row-icon=""
				>
					{icon}
				</span>
				<span className="min-w-0 flex-1 truncate">{label}</span>
				{trailing}
			</button>
		</li>
	);
}

function SectionLabel({ children, id }: { children: string; id: string }) {
	return (
		<h2
			className="px-2 pt-5 pb-1 font-medium text-sidebar-foreground/55 text-xs"
			id={id}
		>
			{children}
		</h2>
	);
}

function Count({ value }: { value: number }) {
	return (
		<span
			aria-hidden="true"
			className="font-medium text-sidebar-foreground/60 text-xs tabular-nums"
		>
			{value}
		</span>
	);
}

const SPACE_ICON: Record<PostSpace["kind"], ReactNode> = {
	general: <Hash aria-hidden="true" strokeWidth={1.75} />,
	project: <Folder aria-hidden="true" strokeWidth={1.75} />,
	team: <Users aria-hidden="true" strokeWidth={1.75} />,
};

const SKELETON_ROWS = [
	{ id: "row-1", width: "w-20" },
	{ id: "row-2", width: "w-24" },
	{ id: "row-3", width: "w-28" },
	{ id: "row-4", width: "w-32" },
	{ id: "row-5", width: "w-24" },
	{ id: "row-6", width: "w-20" },
];

function SidebarSkeleton() {
	return (
		<div aria-hidden="true" className="flex flex-col gap-3 px-2 pt-5">
			<Skeleton className="h-3 w-14" radius="dense" />
			{SKELETON_ROWS.map(({ id, width }) => (
				<div className="flex items-center gap-2" key={id}>
					<Skeleton className="size-4" radius="dense" />
					<Skeleton className={cn("h-3.5", width)} radius="dense" />
				</div>
			))}
		</div>
	);
}

export interface PostsSidebarProps {
	agents: readonly InterfaceAgent[];
	homeCount: number;
	loading: boolean;
	onClose: (() => void) | null;
	onNewPost: () => void;
	onSelect: (view: PostsView) => void;
	spaces: readonly PostSpace[];
	/** The selected view's key; null while a post is open over no view. */
	viewKey: string;
	/** Shown top-left with its monogram, where Campsite puts the org. */
	workspaceName?: string;
}

/** Campsite's sidebar: workspace, Home and Posts, Spaces, then members. */
export function PostsSidebar({
	agents,
	homeCount,
	loading,
	onClose,
	onNewPost,
	onSelect,
	spaces,
	viewKey: currentKey,
	workspaceName = "Ryu",
}: PostsSidebarProps) {
	const tl = useLiteralMessages();
	return (
		<nav
			aria-label="Posts"
			className="flex size-full flex-col bg-sidebar text-sidebar-foreground"
		>
			<div className="flex h-14 shrink-0 items-center gap-2 pr-2 pl-4">
				<span
					aria-hidden="true"
					className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-foreground/[0.08] font-semibold text-sidebar-foreground text-xs"
				>
					{workspaceName.charAt(0).toUpperCase()}
				</span>
				<span className="min-w-0 flex-1 truncate font-semibold text-sm">
					{workspaceName}
				</span>
				<button
					aria-keyshortcuts="C"
					aria-label="New post"
					className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none transition-colors duration-100 hover:bg-sidebar-foreground/[0.06] hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
					onClick={onNewPost}
					title="New post (C)"
					type="button"
				>
					<SquarePen aria-hidden="true" className="size-4" strokeWidth={1.75} />
				</button>
				{onClose ? (
					<button
						aria-label="Close sidebar"
						className="flex size-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 outline-none transition-colors duration-100 hover:bg-sidebar-foreground/[0.06] hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
						onClick={onClose}
						type="button"
					>
						<X aria-hidden="true" className="size-4" strokeWidth={1.75} />
					</button>
				) : null}
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
				<ul className="flex flex-col gap-px">
					<SidebarRow
						active={currentKey === "home"}
						ariaLabel={
							homeCount > 0
								? tl(
										"Home, {count, plural, one {{countLabel} needs} other {{countLabel} need}} you",
										{ count: homeCount, countLabel: String(homeCount) }
									)
								: undefined
						}
						icon={<House aria-hidden="true" strokeWidth={1.75} />}
						label="Home"
						onSelect={() => onSelect({ kind: "home" })}
						trailing={homeCount > 0 ? <Count value={homeCount} /> : null}
					/>
					<SidebarRow
						active={currentKey === "all"}
						icon={<Newspaper aria-hidden="true" strokeWidth={1.75} />}
						label="Posts"
						onSelect={() => onSelect({ kind: "all" })}
					/>
				</ul>
				{loading ? (
					<SidebarSkeleton />
				) : (
					<>
						{spaces.length > 0 ? (
							<section aria-labelledby="posts-sidebar-spaces">
								<SectionLabel id="posts-sidebar-spaces">Spaces</SectionLabel>
								<ul className="flex flex-col gap-px">
									{spaces.map((space) => (
										<SidebarRow
											active={
												currentKey === viewKey({ id: space.id, kind: "space" })
											}
											ariaLabel={
												space.needsYou > 0
													? tl(
															"{spaceName}, {count, plural, one {{countLabel} needs} other {{countLabel} need}} you",
															{
																count: space.needsYou,
																countLabel: String(space.needsYou),
																spaceName: space.name,
															}
														)
													: undefined
											}
											icon={SPACE_ICON[space.kind]}
											key={space.id}
											label={space.name}
											onSelect={() => onSelect({ id: space.id, kind: "space" })}
											trailing={
												space.needsYou > 0 ? (
													<Count value={space.needsYou} />
												) : null
											}
										/>
									))}
								</ul>
							</section>
						) : null}
						{agents.length > 0 ? (
							<section aria-labelledby="posts-sidebar-members">
								<SectionLabel id="posts-sidebar-members">Members</SectionLabel>
								<ul className="flex flex-col gap-px">
									{agents.map((agent) => (
										<SidebarRow
											active={
												currentKey ===
												viewKey({ agentId: agent.id, kind: "member" })
											}
											ariaLabel={
												agent.status === "working"
													? tl("{agentName}, working", {
															agentName: agent.name,
														})
													: undefined
											}
											icon={<PostsAvatar agent={agent} size={20} />}
											key={agent.id}
											label={agent.name}
											onSelect={() =>
												onSelect({ agentId: agent.id, kind: "member" })
											}
											trailing={
												agent.status === "working" ? (
													<span className="text-status-success text-xs">
														Working
													</span>
												) : null
											}
										/>
									))}
								</ul>
							</section>
						) : null}
					</>
				)}
			</div>
		</nav>
	);
}
