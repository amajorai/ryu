import { Skeleton } from "@ryu/ui/components/skeleton.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { PersonaAvatar } from "./persona-avatar.tsx";
import { PERSONA_COLUMN } from "./persona-parts.tsx";

const RAIL_ROWS = ["chat", "feed", "ideas", "goals", "activity"] as const;
const PERSONA_ROWS = ["a", "b", "c", "d"] as const;
const CHIP_WIDTHS = [
	{ key: "main", width: "w-28" },
	{ key: "one", width: "w-44" },
	{ key: "two", width: "w-36" },
	{ key: "three", width: "w-40" },
] as const;
const BUBBLES = [
	{ key: "in-1", side: "self-start", width: "w-2/3" },
	{ key: "out-1", side: "self-end", width: "w-1/2" },
	{ key: "in-2", side: "self-start", width: "w-3/5" },
] as const;

/** The first load: the rail, the profile header and a chat, in outline. */
export function PersonaSkeleton() {
	return (
		<div
			aria-busy="true"
			aria-label="Loading persona"
			className="flex size-full min-h-0"
			role="status"
		>
			<div className="@min-[640px]:flex hidden @min-[1024px]:w-60 w-16 shrink-0 flex-col gap-6 border-sidebar-border border-r bg-sidebar px-3 py-4">
				<div className="flex flex-col gap-0.5">
					{RAIL_ROWS.map((key) => (
						<div className="flex h-9 items-center gap-3 px-2.5" key={key}>
							<Skeleton className="size-4" radius="dense" />
							<Skeleton
								className="@min-[1024px]:block hidden h-3 w-20"
								radius="pill"
							/>
						</div>
					))}
				</div>
				<div className="flex flex-col gap-0.5">
					{PERSONA_ROWS.map((key) => (
						<div className="flex items-center gap-3 px-2 py-1.5" key={key}>
							<Skeleton className="size-8 shrink-0" radius="pill" />
							<div className="@min-[1024px]:flex hidden flex-1 flex-col gap-1.5">
								<Skeleton className="h-3 w-16" radius="pill" />
								<Skeleton className="h-2.5 w-32" radius="pill" />
							</div>
						</div>
					))}
				</div>
			</div>
			<div className="flex min-w-0 flex-1 flex-col">
				<div className="shrink-0 border-border border-b">
					<div
						className={cn(
							PERSONA_COLUMN,
							"flex @min-[640px]:gap-5 gap-3 @min-[640px]:pt-7 pt-4 @min-[640px]:pb-5 pb-3"
						)}
					>
						<Skeleton
							className="@max-[639px]:size-12 size-18 shrink-0"
							radius="pill"
						/>
						<div className="flex flex-1 flex-col gap-1">
							<div className="flex @min-[640px]:h-8 h-7 items-center">
								<Skeleton className="h-6 w-32" radius="dense" />
							</div>
							<div className="flex h-5 items-center">
								<Skeleton className="h-3.5 w-56 max-w-full" radius="pill" />
							</div>
							<div className="flex h-8 items-center">
								<Skeleton className="h-3.5 w-64 max-w-full" radius="pill" />
							</div>
						</div>
					</div>
				</div>
				<div className="shrink-0 border-border border-b">
					<div
						className={cn(PERSONA_COLUMN, "flex gap-2 overflow-hidden py-3")}
					>
						{CHIP_WIDTHS.map((chip) => (
							<Skeleton
								className={`h-8 shrink-0 ${chip.width}`}
								key={chip.key}
								radius="pill"
							/>
						))}
					</div>
				</div>
				<div className="flex min-h-0 flex-1 flex-col">
					<div
						className={cn(
							PERSONA_COLUMN,
							"flex flex-1 flex-col justify-end gap-3 py-6"
						)}
					>
						{BUBBLES.map((bubble) => (
							<Skeleton
								className={`h-14 ${bubble.side} ${bubble.width}`}
								key={bubble.key}
								radius="panel"
								tone="default"
							/>
						))}
					</div>
				</div>
				<div className="shrink-0 border-border border-t">
					<div className={cn(PERSONA_COLUMN, "py-3")}>
						<Skeleton className="h-10 w-full" radius="pill" />
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * No agents: nothing to make a persona of. The host's chat still shows when
 * a thread is open, so a conversation is never hidden behind this state.
 */
export function PersonaEmpty({ threadView }: { threadView: ReactNode | null }) {
	if (threadView !== null) {
		return <div className="flex min-h-0 flex-1 flex-col">{threadView}</div>;
	}
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
			<PersonaAvatar name="Persona" size={72} />
			<h2 className="mt-6 font-semibold text-base">No persona yet</h2>
			<p className="mt-1 max-w-xs text-balance text-muted-foreground text-sm">
				Create an agent and it becomes your persona here, with its chats, feed
				and goals in one place.
			</p>
		</div>
	);
}
