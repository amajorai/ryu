import {
	BookOpen02Icon,
	MoreHorizontalIcon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { Icon } from "@ryu/ui/components/icon.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/popover";
import { Fragment, useState } from "react";
import type { MemoryCitation } from "./memory-citations.ts";
import { isMemoryCitationsAction } from "./message-action-types.ts";
import type {
	ContributedMessageAction,
	MessageActionRuntimeState,
} from "./types.ts";

function MemoryCitationsMenuItem({
	action,
	citations,
}: {
	action: ContributedMessageAction;
	citations?: readonly MemoryCitation[];
}) {
	const [open, setOpen] = useState(false);
	if (!citations || citations.length === 0) {
		return null;
	}

	return (
		<Popover modal={false} onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<DropdownMenuItem closeOnClick={false} onClick={() => setOpen(true)}>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5"
							icon={BookOpen02Icon}
						/>
						{action.label}
					</DropdownMenuItem>
				}
			/>
			<PopoverContent
				align="start"
				className="w-80 max-w-[min(20rem,calc(100vw-2rem))] items-start"
				spacing="rail"
			>
				<div className="min-w-0">
					<p className="font-medium text-foreground">Memories cited</p>
					<ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">
						{citations.map((citation) => (
							<li key={citation.id}>{citation.content}</li>
						))}
					</ul>
				</div>
			</PopoverContent>
		</Popover>
	);
}

export function MessageOverflowMenu({
	actionState,
	align,
	contributedActions,
	onBranch,
	onContributedAction,
	onEdit,
	onRegenerate,
	onRewind,
	onSpeak,
}: {
	actionState?: MessageActionRuntimeState;
	align: "start" | "end";
	contributedActions?: ContributedMessageAction[];
	onBranch?: () => void;
	onContributedAction?: (
		action: ContributedMessageAction,
		value?: string
	) => void;
	onEdit?: () => void;
	onRegenerate?: () => void;
	onRewind?: () => void;
	onSpeak?: () => void;
}) {
	const [speaking, setSpeaking] = useState(false);
	const hasOverflow = Boolean(
		onBranch ||
			onEdit ||
			onRegenerate ||
			onRewind ||
			onSpeak ||
			contributedActions?.length
	);
	if (!hasOverflow) {
		return null;
	}

	const speak = async () => {
		if (speaking || !onSpeak) {
			return;
		}
		setSpeaking(true);
		try {
			onSpeak();
		} finally {
			setSpeaking(false);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						appearance="transcript-more"
						aria-label="More message actions"
						onMouseDown={(event) => event.stopPropagation()}
						onPointerDown={(event) => event.stopPropagation()}
						size="icon"
						title="More message actions"
						type="button"
						variant="ghost"
					>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3.5"
							icon={MoreHorizontalIcon}
						/>
					</Button>
				}
			/>
			<DropdownMenuContent
				align={align}
				className="w-auto min-w-48"
				withBackdrop={false}
			>
				{onEdit ? (
					<DropdownMenuItem onClick={onEdit}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:pencil"
						/>
						Edit message
					</DropdownMenuItem>
				) : null}
				{onRegenerate ? (
					<DropdownMenuItem onClick={onRegenerate}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:refresh-cw"
						/>
						Regenerate reply
					</DropdownMenuItem>
				) : null}
				{onBranch ? (
					<DropdownMenuItem onClick={onBranch}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:git-branch"
						/>
						Fork chat from here
					</DropdownMenuItem>
				) : null}
				{onRewind ? (
					<DropdownMenuItem onClick={onRewind}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:history"
						/>
						Rewind to here
					</DropdownMenuItem>
				) : null}
				{onSpeak ? (
					<DropdownMenuItem disabled={speaking} onClick={() => void speak()}>
						<Icon
							aria-hidden="true"
							className="size-3.5"
							icon="lucide:volume-2"
						/>
						{speaking ? "Speaking…" : "Speak reply"}
					</DropdownMenuItem>
				) : null}
				{contributedActions?.map((action) => {
					if (isMemoryCitationsAction(action)) {
						return (
							<MemoryCitationsMenuItem
								action={action}
								citations={actionState?.memoryCitations}
								key={action.id}
							/>
						);
					}
					if (action.kind === "toggle-group" && action.states?.length) {
						return (
							<Fragment key={action.id}>
								{action.states.map((state) => {
									const active =
										actionState?.toggleValues?.[action.id] === state.value;
									return (
										<DropdownMenuItem
											key={`${action.id}:${state.value}`}
											onClick={() =>
												onContributedAction?.(
													action,
													active ? undefined : state.value
												)
											}
										>
											{state.icon || state.active_icon ? (
												<Icon
													aria-hidden="true"
													className="size-3.5"
													icon={
														active
															? (state.active_icon ?? state.icon ?? "")
															: (state.icon ?? "")
													}
												/>
											) : null}
											{state.label}
											{active ? (
												<HugeiconsIcon
													aria-hidden="true"
													className="ml-auto size-3.5"
													icon={Tick02Icon}
												/>
											) : null}
										</DropdownMenuItem>
									);
								})}
							</Fragment>
						);
					}
					return (
						<DropdownMenuItem
							key={action.id}
							onClick={() => onContributedAction?.(action)}
						>
							{action.icon ? (
								<Icon
									aria-hidden="true"
									className="size-3.5"
									icon={action.icon}
								/>
							) : null}
							{action.label}
						</DropdownMenuItem>
					);
				})}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
