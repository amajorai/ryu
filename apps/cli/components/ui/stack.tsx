// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */
import type { ReactNode } from "react";

export interface StackProps {
	direction?: "vertical" | "horizontal";
	gap?: number;
	children: ReactNode;
	width?: number | string;
	height?: number | string;
	alignItems?: "flex-start" | "center" | "flex-end";
	justifyContent?:
		| "flex-start"
		| "center"
		| "flex-end"
		| "space-between"
		| "space-around";
}

export const Stack = ({
	direction = "vertical",
	children,
	width,
	height,
}: StackProps) => (
	<box
		flexDirection={direction === "vertical" ? "column" : "row"}
		width={width}
		height={height}
	>
		{children}
	</box>
);
