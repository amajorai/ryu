import { Home01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { ProjectGlyph } from "@/src/components/layout/ProjectIconDialog.tsx";
import {
	useRailProject,
	useSidebarProjectRailPreference,
} from "@/src/hooks/useSidebarProjectRail.ts";
import { folderKey } from "@/src/lib/folder-path.ts";
import { useWorkspaceStore } from "@/src/store/useWorkspaceStore.ts";
import type { ProjectBucket } from "./sidebar-conversation-list.tsx";

/** One or two letters for a project with no custom icon, Discord-style. */
export function projectInitials(name: string): string {
	const words = name
		.replace(/[-_.]+/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	if (words.length === 0) {
		return "?";
	}
	if (words.length === 1) {
		return words[0].slice(0, 2).toUpperCase();
	}
	return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function RailButton({
	active,
	children,
	label,
	onClick,
	testId,
}: {
	active: boolean;
	children: ReactNode;
	label: string;
	onClick: () => void;
	testId: string;
}) {
	return (
		<div className="relative flex w-full shrink-0 justify-center">
			{/* The active pill hugs the rail edge and grows on hover, the way a
			    server list marks the open server. */}
			<span
				aria-hidden
				className={cn(
					"absolute top-1/2 left-0 w-1 -translate-y-1/2 rounded-r-full bg-foreground transition-[height,opacity] duration-(--duration-base)",
					active ? "h-8 opacity-100" : "h-2 opacity-0"
				)}
			/>
			<Tooltip>
				<TooltipTrigger
					render={
						<button
							aria-current={active ? "page" : undefined}
							aria-label={label}
							className={cn(
								"flex size-10 items-center justify-center overflow-hidden rounded-[1.25rem] bg-sidebar-accent font-medium text-sidebar-foreground text-sm transition-[border-radius,background-color,color] duration-(--duration-base) hover:rounded-xl hover:bg-primary hover:text-primary-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60",
								active && "rounded-xl bg-primary text-primary-foreground"
							)}
							data-testid={testId}
							onClick={onClick}
							type="button"
						>
							{children}
						</button>
					}
				/>
				<TooltipContent side="right">{label}</TooltipContent>
			</Tooltip>
		</div>
	);
}

function RailProjectButton({
	active,
	onSelect,
	project,
}: {
	active: boolean;
	onSelect: (path: string) => void;
	project: ProjectBucket;
}) {
	const icon = useWorkspaceStore((state) => state.projectIcons[project.path]);
	const name = useWorkspaceStore(
		(state) => state.projectNames[project.path]?.trim() || project.name
	);
	return (
		<RailButton
			active={active}
			label={name}
			onClick={() => onSelect(project.path)}
			testId="sidebar-project-rail-project"
		>
			<ProjectGlyph
				fallback={<span aria-hidden>{projectInitials(name)}</span>}
				icon={icon}
				size={20}
			/>
		</RailButton>
	);
}

/**
 * The opt-in Discord-style project rail: Home, then one icon per project. Picking
 * a project focuses the sidebar on its chats and makes it the active workspace
 * folder, so a new chat starts there; Home shows every project again.
 */
export function SidebarProjectRail({
	projects,
}: {
	projects: ProjectBucket[];
}) {
	const [focused, setFocused] = useRailProject();
	const setFolder = useWorkspaceStore((state) => state.setFolder);
	const focusedKey = focused ? folderKey(focused) : null;
	const focusedExists =
		focusedKey !== null &&
		projects.some((project) => folderKey(project.path) === focusedKey);
	const handleSelect = (path: string) => {
		setFocused(path);
		setFolder(path).catch(() => undefined);
	};
	return (
		<nav
			aria-label="Projects"
			className="scroll-fade flex w-14 shrink-0 flex-col items-center gap-2 overflow-y-auto overscroll-contain border-sidebar-border border-r py-2 [scrollbar-width:none]"
			data-testid="sidebar-project-rail"
		>
			<RailButton
				active={!focusedExists}
				label="All projects"
				onClick={() => setFocused(null)}
				testId="sidebar-project-rail-home"
			>
				<HugeiconsIcon className="size-5" icon={Home01Icon} />
			</RailButton>
			{projects.length > 0 ? (
				<hr aria-hidden className="h-px w-8 shrink-0 border-0 bg-border" />
			) : null}
			{projects.map((project) => (
				<RailProjectButton
					active={focusedKey === folderKey(project.path)}
					key={project.path}
					onSelect={handleSelect}
					project={project}
				/>
			))}
		</nav>
	);
}

/**
 * Lays the sidebar panel out beside the project rail while the rail is on;
 * otherwise renders the panel unchanged.
 */
export function SidebarProjectRailFrame({
	children,
	disabled = false,
	projects,
}: {
	children: ReactNode;
	disabled?: boolean;
	projects: ProjectBucket[];
}) {
	const [enabled] = useSidebarProjectRailPreference();
	if (!enabled || disabled) {
		return children;
	}
	return (
		<div className="flex min-h-0 flex-1">
			<SidebarProjectRail projects={projects} />
			<div className="flex min-w-0 flex-1 flex-col">{children}</div>
		</div>
	);
}
