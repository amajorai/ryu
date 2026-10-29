"use client";

import {
	formatDateValue,
	getDateDisplayLabel,
	parseCanonicalDateValue,
} from "@platejs/date";
import { Calendar } from "@ryu/ui/components/editor/ui/calendar.tsx";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { inlineSuggestionVariants } from "@ryu/ui/lib/suggestion.ts";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { TDateElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import { PlateElement, useReadOnly } from "platejs/react";

export function DateElement(props: PlateElementProps<TDateElement>) {
	const { editor, element } = props;
	const readOnly = useReadOnly();
	const selectedDate = parseCanonicalDateValue(element.date ?? "");

	const trigger = (
		<span
			className={cn(
				"w-fit cursor-pointer rounded-sm bg-muted px-1 text-muted-foreground",
				inlineSuggestionVariants()
			)}
			contentEditable={false}
			draggable
		>
			{element.date || element.rawDate ? (
				getDateDisplayLabel(element)
			) : (
				<span>Pick a date</span>
			)}
		</span>
	);

	return (
		<PlateElement
			{...props}
			attributes={{
				...props.attributes,
				contentEditable: false,
			}}
			className="inline-block"
		>
			{readOnly ? (
				trigger
			) : (
				<Popover>
					<PopoverTrigger>{trigger}</PopoverTrigger>
					<PopoverContent className="w-auto p-0">
						{/* The popover mounts on each open, so it opens on the node's month. */}
						<Calendar
							defaultMonth={selectedDate}
							mode="single"
							onSelect={(date) => {
								if (!date) {
									return;
								}

								editor.tf.setNodes(
									{ date: formatDateValue(date), rawDate: undefined },
									{ at: element }
								);
							}}
							selected={selectedDate}
						/>
					</PopoverContent>
				</Popover>
			)}
			{props.children}
		</PlateElement>
	);
}
