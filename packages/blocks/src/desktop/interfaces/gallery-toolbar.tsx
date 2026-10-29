import { Button } from "@ryu/ui/components/button.tsx";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@ryu/ui/components/input-group.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import {
	type InterfaceAgent,
	THREAD_STATUS_LABELS,
} from "@ryuhq/protocol/interfaces";
import { Plus, Search, X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { GalleryAvatar } from "./gallery-avatar.tsx";
import {
	GALLERY_STATUS_FILTERS,
	type GalleryFilter,
	type GalleryStatusFilter,
} from "./gallery-model.ts";

function Chip({
	children,
	className,
	onClick,
	pressed,
}: {
	children: ReactNode;
	className?: string;
	onClick: () => void;
	pressed: boolean;
}) {
	return (
		<button
			aria-pressed={pressed}
			className={cn(
				"inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 font-medium text-sm outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none",
				pressed
					? "bg-foreground text-background"
					: "bg-muted text-foreground hover:bg-[color-mix(in_oklab,var(--muted),var(--foreground)_7%)]",
				className
			)}
			onClick={onClick}
			type="button"
		>
			{children}
		</button>
	);
}

/**
 * The board's header: a search field, "New conversation", and a row of filter
 * chips (All, three statuses, then one per agent) that scrolls sideways when
 * it runs out of room.
 */
export function GalleryToolbar({
	agents,
	filter,
	inputRef,
	onAgent,
	onNew,
	onQuery,
	onStatus,
	compact,
}: {
	agents: InterfaceAgent[];
	compact: boolean;
	filter: GalleryFilter;
	inputRef: RefObject<HTMLInputElement | null>;
	onAgent: (agentId: string | null) => void;
	onNew: () => void;
	onQuery: (query: string) => void;
	onStatus: (status: GalleryStatusFilter | null) => void;
}) {
	return (
		<header className="flex shrink-0 flex-col gap-3 pt-4 pb-4">
			<div className="flex items-center gap-2 px-[var(--gallery-inset)]">
				<div className="min-w-0 flex-1" role="search">
					<InputGroup className="h-10 bg-muted">
						<InputGroupAddon>
							<Search aria-hidden="true" />
						</InputGroupAddon>
						<InputGroupInput
							aria-label="Search conversations"
							autoComplete="off"
							onChange={(event) => onQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape" && filter.query) {
									event.stopPropagation();
									onQuery("");
								}
							}}
							placeholder={
								compact ? "Search" : "Search conversations, agents, projects"
							}
							ref={inputRef}
							spellCheck={false}
							type="search"
							value={filter.query}
						/>
						<InputGroupAddon align="inline-end">
							{filter.query ? (
								<InputGroupButton
									aria-label="Clear search"
									onClick={() => {
										onQuery("");
										inputRef.current?.focus();
									}}
									size="icon-xs"
								>
									<X aria-hidden="true" />
								</InputGroupButton>
							) : (
								<Kbd className={cn(compact && "hidden")}>/</Kbd>
							)}
						</InputGroupAddon>
					</InputGroup>
				</div>
				<Button
					aria-label="New conversation"
					className={cn("h-10", compact && "w-10 px-0")}
					onClick={onNew}
					radius="pill"
				>
					<Plus aria-hidden="true" data-icon="inline-start" />
					<span className={cn(compact && "sr-only")}>New conversation</span>
				</Button>
			</div>
			<div
				aria-label="Filter conversations"
				className="flex items-center gap-2 overflow-x-auto px-[var(--gallery-inset)] [scrollbar-width:none]"
				role="group"
			>
				<Chip onClick={() => onStatus(null)} pressed={filter.status === null}>
					All
				</Chip>
				{GALLERY_STATUS_FILTERS.map((status) => (
					<Chip
						key={status}
						onClick={() => onStatus(filter.status === status ? null : status)}
						pressed={filter.status === status}
					>
						{THREAD_STATUS_LABELS[status]}
					</Chip>
				))}
				{agents.length > 0 ? (
					<span
						aria-hidden="true"
						className="mx-1 h-5 w-px shrink-0 bg-border"
					/>
				) : null}
				{agents.map((agent) => (
					<Chip
						className="ps-1"
						key={agent.id}
						onClick={() =>
							onAgent(filter.agentId === agent.id ? null : agent.id)
						}
						pressed={filter.agentId === agent.id}
					>
						<GalleryAvatar agent={agent} size={24} />
						{agent.name}
					</Chip>
				))}
			</div>
		</header>
	);
}
