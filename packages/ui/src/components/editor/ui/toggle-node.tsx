"use client";

import { useToggleButton, useToggleButtonState } from "@platejs/toggle/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import { ChevronRight } from "lucide-react";
import type { PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";

export function ToggleElement(props: PlateElementProps) {
	const tl = useLiteralMessages();
	const element = props.element;
	// SAFETY: Native Toggle state tests this raw id with Set.has; its click
	// API adds/deletes the same identity. No string operation or parsing occurs.
	const state = useToggleButtonState(element.id as string);
	const { buttonProps, open } = useToggleButton(state);

	return (
		<PlateElement {...props} className="ps-6">
			<Button
				aria-expanded={open}
				aria-label={open ? tl("Collapse") : tl("Expand")}
				className="absolute -start-0.5 top-0 size-6 cursor-pointer select-none items-center justify-center rounded-md p-px text-muted-foreground transition-colors hover:bg-accent [&_svg]:size-4"
				contentEditable={false}
				size="icon"
				variant="ghost"
				{...buttonProps}
			>
				<ChevronRight
					className={
						open
							? "rotate-90 transition-transform duration-75 rtl:-rotate-90 rtl:-scale-x-100"
							: "rotate-0 transition-transform duration-75 rtl:-scale-x-100"
					}
				/>
			</Button>
			{props.children}
		</PlateElement>
	);
}
