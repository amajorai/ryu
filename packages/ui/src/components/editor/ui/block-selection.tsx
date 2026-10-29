"use client";

import { DndPlugin } from "@platejs/dnd";
import { useBlockSelected } from "@platejs/selection/react";
import { cva } from "class-variance-authority";
import type { AnyPluginConfig, TElement } from "platejs";
import { type PlateElementProps, usePluginOption } from "platejs/react";

export const blockSelectionVariants = cva(
	"pointer-events-none absolute inset-0 z-1 bg-primary/[.13] transition-opacity",
	{
		defaultVariants: {
			active: true,
		},
		variants: {
			active: {
				false: "opacity-0",
				true: "opacity-100",
			},
		},
	}
);

export function BlockSelection<N extends TElement, C extends AnyPluginConfig>(
	props: PlateElementProps<N, C>
) {
	const isBlockSelected = useBlockSelected();
	const isDragging = usePluginOption(DndPlugin, "isDragging");

	if (
		!isBlockSelected ||
		props.plugin.key === "tr" ||
		props.plugin.key === "table"
	) {
		return null;
	}

	return (
		<div
			className={blockSelectionVariants({
				active: isBlockSelected && !isDragging,
			})}
			data-slot="block-selection"
		/>
	);
}
