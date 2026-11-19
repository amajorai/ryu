"use client";

import {
	useLinkToolbarButton,
	useLinkToolbarButtonState,
} from "@platejs/link/react";
import { Link } from "lucide-react";
import type * as React from "react";

import { useHyperlinkLabel } from "./hyperlink-label.ts";
import { ToolbarButton } from "./toolbar.tsx";

export function LinkToolbarButton(
	props: React.ComponentProps<typeof ToolbarButton>
) {
	const state = useLinkToolbarButtonState();
	const { props: buttonProps } = useLinkToolbarButton(state);
	const tooltip = useHyperlinkLabel();

	return (
		<ToolbarButton
			{...props}
			{...buttonProps}
			data-plate-focus
			tooltip={tooltip}
		>
			<Link />
		</ToolbarButton>
	);
}
