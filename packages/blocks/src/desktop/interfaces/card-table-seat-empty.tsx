import { Button } from "@ryu/ui/components/button.tsx";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { SeatMenuAlign, SeatMenuSide } from "./card-table-seat-menu.tsx";

/** The open seat's one action: deal a thread; `onDone` closes the menu. */
export function EmptySeatMenuBody({
	onDeal,
	onDone,
}: {
	onDeal: () => void;
	onDone: () => void;
}) {
	return (
		<Button
			className="w-full"
			onClick={() => {
				onDone();
				onDeal();
			}}
			size="sm"
			type="button"
		>
			<Plus aria-hidden="true" data-icon="inline-start" />
			Deal a thread
		</Button>
	);
}

/**
 * A chair nobody sits in. Like an agent's seat it opens a small menu, whose
 * one action deals a new thread with no agent picked yet.
 */
export function EmptySeat({
	align = "center",
	compact,
	onDeal,
	side = "bottom",
}: {
	align?: SeatMenuAlign;
	compact: boolean;
	onDeal: () => void;
	side?: SeatMenuSide;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Popover onOpenChange={setOpen} open={open}>
			<PopoverTrigger
				render={
					<button
						aria-label="Open seat. Seat menu"
						className={cn(
							"gk-display flex items-center justify-center gap-1.5 rounded-2xl border-(--gk-plate)/60 border-[3px] border-dashed bg-(--gk-edge)/35 text-(--gk-plate) text-[14px] outline-none transition-colors hover:bg-(--gk-edge)/55 focus-visible:outline-(--gk-focus) focus-visible:outline-3 focus-visible:outline-solid aria-expanded:bg-(--gk-edge)/55",
							compact ? "size-12 rounded-full" : "h-12 w-36"
						)}
						data-empty-seat=""
						type="button"
					/>
				}
			>
				<Plus aria-hidden="true" className="size-4" strokeWidth={3} />
				{compact ? null : <span>Open seat</span>}
			</PopoverTrigger>
			<PopoverContent
				align={align}
				appearance="composer-menu"
				className="w-64 gap-3 bg-popover"
				corners="rounded"
				side={side}
				sideOffset={8}
				spacing="inset"
			>
				<PopoverHeader className="px-2 pt-1">
					<PopoverTitle className="font-semibold text-sm">
						Open seat
					</PopoverTitle>
					<PopoverDescription className="text-xs">
						Nobody sits here yet. Deal a thread and pick who joins in the
						composer.
					</PopoverDescription>
				</PopoverHeader>
				<EmptySeatMenuBody onDeal={onDeal} onDone={() => setOpen(false)} />
			</PopoverContent>
		</Popover>
	);
}
