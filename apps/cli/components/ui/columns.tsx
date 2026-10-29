// @ts-nocheck - vendored termcn component, see scripts/vendor-termcn.ts
/* @jsxImportSource @opentui/react */

import type { ReactNode } from "react";
import React from "react";

export interface ColumnsProps {
	children: ReactNode;
	gap?: number;
	align?: "top" | "center" | "bottom";
}

const ALIGN_MAP = {
	bottom: "flex-end",
	center: "center",
	top: "flex-start",
} satisfies Record<
	NonNullable<ColumnsProps["align"]>,
	"flex-start" | "center" | "flex-end"
>;

export const Columns = ({ children, align = "top" }: ColumnsProps) => {
	const items = React.Children.toArray(children);

	return (
		<box flexDirection="row" alignItems={ALIGN_MAP[align]}>
			{items.map((child, index) => (
				<box key={index} flexGrow={1} flexDirection="column">
					{child}
				</box>
			))}
		</box>
	);
};
