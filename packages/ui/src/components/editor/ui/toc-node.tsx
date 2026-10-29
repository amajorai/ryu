"use client";

import { useTocElement, useTocElementState } from "@platejs/toc/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import { cva } from "class-variance-authority";
import type { PlateElementProps } from "platejs/react";
import { PlateElement } from "platejs/react";

const headingItemVariants = cva(
	"block h-auto w-full cursor-pointer truncate rounded-none px-0.5 py-1.5 text-start font-medium underline decoration-[0.5px] underline-offset-4",
	{
		variants: {
			active: {
				false: "text-muted-foreground hover:bg-accent hover:text-foreground",
				true: "bg-accent text-foreground decoration-foreground",
			},
			depth: {
				1: "ps-0.5",
				2: "ps-[26px]",
				3: "ps-[50px]",
			},
		},
	}
);

export function TocElement(props: PlateElementProps) {
	const state = useTocElementState();
	const { props: btnProps } = useTocElement(state);
	const { activeContentId, headingList } = state;

	return (
		<PlateElement {...props} className="mb-1 p-0">
			<div contentEditable={false}>
				{headingList.length > 0 ? (
					headingList.map((item) => (
						<Button
							aria-current={
								item.id === activeContentId ? "location" : undefined
							}
							className={headingItemVariants({
								active: item.id === activeContentId,
								// SAFETY: Installed cva indexes its actual variant table and omits
								// unknown keys. The native Heading depth is forwarded unchanged:
								// only 1/2/3 add spacing; 4/5/6 and custom depths keep the
								// existing no-depth-class fallback. No closed-set membership is proved.
								depth: item.depth as 1 | 2 | 3,
							})}
							key={item.id}
							onClick={(e) => btnProps.onClick(e, item, "smooth")}
							variant="ghost"
						>
							{item.title}
						</Button>
					))
				) : (
					<div className="text-muted-foreground text-sm">
						Create a heading to display the table of contents.
					</div>
				)}
			</div>
			{props.children}
		</PlateElement>
	);
}
