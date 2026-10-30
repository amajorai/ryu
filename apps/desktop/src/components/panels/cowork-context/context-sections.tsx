// The context rail's sections: one flush list of disclosures. Each section is
// an `h-8` title row (title, optional count, one chevron, optional trailing
// action) over its body, separated from the next by a full-width hairline. The
// body opens with a `grid-template-rows` 0fr → 1fr transition, so nothing reads
// or animates `height` and there is no spring, card, radius or fill. Only one
// section is open at a time, matching the accordion it replaces.

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type ReactNode, useId, useState } from "react";

export interface ContextSectionItem {
	action?: ReactNode;
	description?: ReactNode;
	disabled?: boolean;
	icon?: ReactNode;
	id: string;
	title: ReactNode;
}

function ContextSection({
	item,
	open,
	onToggle,
}: {
	item: ContextSectionItem;
	onToggle: () => void;
	open: boolean;
}) {
	const baseId = useId();
	const contentId = `${baseId}-content`;
	const triggerId = `${baseId}-trigger`;
	return (
		<div
			className="border-border border-b last:border-b-0"
			data-slot="context-section"
			data-state={open ? "open" : "closed"}
		>
			<div className="group/section flex h-8 min-w-0 items-center gap-1">
				<button
					aria-controls={contentId}
					aria-expanded={open}
					className={cn(
						"flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-sm outline-none",
						"focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
					)}
					disabled={item.disabled}
					id={triggerId}
					onClick={onToggle}
					type="button"
				>
					{item.icon ? (
						<span
							className="grid size-4 shrink-0 place-items-center text-muted-foreground"
							data-slot="context-section-icon"
						>
							{item.icon}
						</span>
					) : null}
					<span className="min-w-0 flex-1 truncate">{item.title}</span>
					<HugeiconsIcon
						aria-hidden
						className={cn(
							"size-4 shrink-0 text-muted-foreground transition-transform duration-(--duration-base) ease-move",
							open ? "rotate-180" : "rotate-0"
						)}
						icon={ArrowDown01Icon}
					/>
				</button>
				{item.action ? (
					<div className="flex shrink-0 items-center">{item.action}</div>
				) : null}
			</div>
			<div
				aria-hidden={!open}
				aria-labelledby={triggerId}
				className={cn(
					"grid transition-[grid-template-rows] duration-(--duration-base) ease-move",
					open && item.description ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
				)}
				id={contentId}
				inert={!open}
				role="region"
			>
				<div className="min-h-0 overflow-hidden">
					<div className="pt-1 pb-3 text-muted-foreground text-sm">
						{item.description}
					</div>
				</div>
			</div>
		</div>
	);
}

export function ContextSections({
	defaultValue,
	items,
}: {
	defaultValue?: string | null;
	items: ContextSectionItem[];
}) {
	const [openId, setOpenId] = useState<string | null>(defaultValue ?? null);
	return (
		<div className="flex w-full flex-col" data-slot="context-sections">
			{items.map((item) => (
				<ContextSection
					item={item}
					key={item.id}
					onToggle={() =>
						setOpenId((current) => (current === item.id ? null : item.id))
					}
					open={openId === item.id}
				/>
			))}
		</div>
	);
}
