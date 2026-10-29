import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Command,
	CommandDialog,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
	CommandShortcut,
} from "@ryu/ui/components/command.tsx";
import {
	type BoardFilter,
	type BoardParams,
	type InterfaceSnapshot,
	isBoardFilterEmpty,
	THREAD_STATUS_LABELS,
	THREAD_STATUS_ORDER,
	threadStatus,
} from "@ryuhq/protocol/interfaces";
import {
	Columns3,
	FolderKanban,
	List,
	Plus,
	Rows3,
	User,
	X,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import type { BoardStartInput } from "./board-column.tsx";
import type { BoardFilterField } from "./board-filter.tsx";
import { BoardStatusDot } from "./board-status.tsx";
import { agentById } from "./interface-renderer.ts";

/**
 * Every typed word must appear somewhere in the item's text. cmdk's default
 * fuzzy score lets "list" match any thread whose letters happen to spell it.
 */
function matchWords(value: string, search: string, keywords?: string[]) {
	const haystack = [value, ...(keywords ?? [])].join(" ").toLowerCase();
	const words = search.toLowerCase().split(/\s+/).filter(Boolean);
	return words.every((word) => haystack.includes(word)) ? 1 : 0;
}

/**
 * A fixed 16px leading slot, so every label in the menu starts at the same x
 * whether it follows a status dot, an icon, or a face.
 */
function Lead({ children }: { children: ReactNode }) {
	return (
		<span
			aria-hidden="true"
			className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4"
		>
			{children}
		</span>
	);
}

/** Threads shown before the user types; typing searches all of them. */
const RECENT_LIMIT = 6;

const GROUP_LABELS: Record<BoardParams["groupBy"], string> = {
	agent: "Agent",
	project: "Project",
	status: "Status",
};

export interface BoardPaletteActions {
	clearFilters: () => void;
	closeThread: () => void;
	openThread: (threadId: string) => void;
	setGroupBy: (groupBy: BoardParams["groupBy"]) => void;
	setView: (view: BoardParams["view"]) => void;
	startThread: (input: BoardStartInput) => void;
	toggleFilter: (field: BoardFilterField, value: string) => void;
}

/**
 * The Board's command menu (Mod+Shift+K): jump to a thread, start one with an agent
 * or in a project, switch between list and board, regroup, and filter.
 */
export function BoardCommandPalette({
	actions,
	filter,
	groupBy,
	onOpenChange,
	open,
	panelOpen,
	snapshot,
	view,
}: {
	actions: BoardPaletteActions;
	filter: BoardFilter;
	groupBy: BoardParams["groupBy"];
	onOpenChange: (open: boolean) => void;
	open: boolean;
	panelOpen: boolean;
	snapshot: InterfaceSnapshot;
	view: BoardParams["view"];
}) {
	const tl = useLiteralMessages();
	const [search, setSearch] = useState("");
	const searching = search.trim().length > 0;
	const threads = [...snapshot.threads].sort((a, b) =>
		b.updatedAt.localeCompare(a.updatedAt)
	);
	const shownThreads = searching ? threads : threads.slice(0, RECENT_LIMIT);
	const agents = [...snapshot.agents].sort((a, b) =>
		a.name.localeCompare(b.name)
	);
	const projects = snapshot.groups
		.filter((group) => group.kind === "project")
		.sort((a, b) => a.name.localeCompare(b.name));
	const groups = [...snapshot.groups].sort((a, b) =>
		a.name.localeCompare(b.name)
	);

	const run = (action: () => void) => {
		onOpenChange(false);
		setSearch("");
		action();
	};

	return (
		<CommandDialog
			className="rounded-xl!"
			description="Jump to a thread, start one, or change how the board is shown."
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) {
					setSearch("");
				}
			}}
			open={open}
			title="Board commands"
		>
			<Command filter={matchWords}>
				<CommandInput
					autoFocus
					onValueChange={setSearch}
					placeholder="Type a command or search threads…"
					value={search}
				/>
				<CommandList className="max-h-[min(60vh,28rem)] p-1">
					<CommandEmpty>No commands or threads match.</CommandEmpty>
					{shownThreads.length > 0 ? (
						<CommandGroup heading={searching ? "Threads" : "Recent threads"}>
							{shownThreads.map((thread) => {
								const lead = agentById(snapshot, thread.agentIds[0]);
								const title = thread.title.trim() || "Untitled thread";
								return (
									<CommandItem
										key={thread.id}
										keywords={[thread.lastMessage ?? "", lead?.name ?? ""]}
										onSelect={() => run(() => actions.openThread(thread.id))}
										value={`${title} ${thread.id}`}
									>
										<Lead>
											<BoardStatusDot
												pulse={false}
												status={threadStatus(thread)}
											/>
										</Lead>
										<span className="truncate">{title}</span>
										{lead ? (
											<CommandShortcut className="shrink-0 font-normal tracking-normal">
												{lead.name}
											</CommandShortcut>
										) : null}
									</CommandItem>
								);
							})}
						</CommandGroup>
					) : null}
					<CommandSeparator />
					<CommandGroup heading="Create">
						<CommandItem
							onSelect={() => run(() => actions.startThread({}))}
							value="create new thread"
						>
							<Lead>
								<Plus />
							</Lead>
							New thread
							<CommandShortcut>C</CommandShortcut>
						</CommandItem>
						{agents.map((agent) => (
							<CommandItem
								key={agent.id}
								onSelect={() =>
									run(() => actions.startThread({ agentId: agent.id }))
								}
								value={`create new thread with ${agent.name} ${agent.id}`}
							>
								<Lead>
									<BoardAvatar
										agent={agent}
										className="size-4"
										name={agent.name}
										size={20}
									/>
								</Lead>
								{tl("New thread with {name}", { name: agent.name })}
							</CommandItem>
						))}
						{projects.map((project) => (
							<CommandItem
								key={project.id}
								onSelect={() =>
									run(() => actions.startThread({ projectId: project.id }))
								}
								value={`create new thread in ${project.name} ${project.id}`}
							>
								<Lead>
									<FolderKanban />
								</Lead>
								{tl("New thread in {name}", { name: project.name })}
							</CommandItem>
						))}
					</CommandGroup>
					<CommandSeparator />
					<CommandGroup heading="View">
						<CommandItem
							data-checked={view === "list"}
							onSelect={() => run(() => actions.setView("list"))}
							value="view show as list"
						>
							<Lead>
								<List />
							</Lead>
							Show as list
						</CommandItem>
						<CommandItem
							data-checked={view === "board"}
							onSelect={() => run(() => actions.setView("board"))}
							value="view show as board kanban"
						>
							<Lead>
								<Columns3 />
							</Lead>
							Show as board
						</CommandItem>
						{(["status", "agent", "project"] as const).map((option) => (
							<CommandItem
								data-checked={groupBy === option}
								key={option}
								onSelect={() => run(() => actions.setGroupBy(option))}
								value={`view group by ${option}`}
							>
								<Lead>
									<Rows3 />
								</Lead>
								{tl("Group by {groupLabel}", {
									groupLabel: GROUP_LABELS[option].toLowerCase(),
								})}
							</CommandItem>
						))}
					</CommandGroup>
					<CommandSeparator />
					<CommandGroup heading="Filter">
						{THREAD_STATUS_ORDER.map((status) => (
							<CommandItem
								data-checked={filter.statuses.includes(status)}
								key={status}
								onSelect={() =>
									run(() => actions.toggleFilter("statuses", status))
								}
								value={`filter status ${THREAD_STATUS_LABELS[status]}`}
							>
								<Lead>
									<BoardStatusDot pulse={false} status={status} />
								</Lead>
								{tl("Status: {status}", {
									status: THREAD_STATUS_LABELS[status],
								})}
							</CommandItem>
						))}
						{agents.map((agent) => (
							<CommandItem
								data-checked={filter.agentIds.includes(agent.id)}
								key={agent.id}
								onSelect={() =>
									run(() => actions.toggleFilter("agentIds", agent.id))
								}
								value={`filter agent ${agent.name} ${agent.id}`}
							>
								<Lead>
									<User />
								</Lead>
								{tl("Agent: {name}", { name: agent.name })}
							</CommandItem>
						))}
						{groups.map((group) => (
							<CommandItem
								data-checked={filter.groupIds.includes(group.id)}
								key={group.id}
								onSelect={() =>
									run(() => actions.toggleFilter("groupIds", group.id))
								}
								value={`filter ${group.kind} ${group.name} ${group.id}`}
							>
								<Lead>
									<FolderKanban />
								</Lead>
								{group.kind === "team" ? "Team" : "Project"}: {group.name}
							</CommandItem>
						))}
						{isBoardFilterEmpty(filter) ? null : (
							<CommandItem
								onSelect={() => run(actions.clearFilters)}
								value="filter clear all filters"
							>
								<Lead>
									<X />
								</Lead>
								Clear filters
							</CommandItem>
						)}
					</CommandGroup>
					{panelOpen ? (
						<>
							<CommandSeparator />
							<CommandGroup heading="Thread">
								<CommandItem
									onSelect={() => run(actions.closeThread)}
									value="thread close open thread"
								>
									<Lead>
										<X />
									</Lead>
									Close thread
									<CommandShortcut>Esc</CommandShortcut>
								</CommandItem>
							</CommandGroup>
						</>
					) : null}
				</CommandList>
			</Command>
		</CommandDialog>
	);
}
