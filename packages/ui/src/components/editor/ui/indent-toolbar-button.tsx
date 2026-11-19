"use client";

import { useIndentButton, useOutdentButton } from "@platejs/indent/react";
import { IndentIcon, OutdentIcon } from "lucide-react";
import type * as React from "react";

import { ToolbarButton } from "./toolbar.tsx";

export function IndentToolbarButton(
	props: React.ComponentProps<typeof ToolbarButton>
) {
	const { props: buttonProps } = useIndentButton();

	return (
		<ToolbarButton {...props} {...buttonProps} tooltip="Indent">
			<IndentIcon className="rtl:-scale-x-100" />
		</ToolbarButton>
	);
}

export function OutdentToolbarButton(
	props: React.ComponentProps<typeof ToolbarButton>
) {
	const { props: buttonProps } = useOutdentButton();

	return (
		<ToolbarButton {...props} {...buttonProps} tooltip="Outdent">
			<OutdentIcon className="rtl:-scale-x-100" />
		</ToolbarButton>
	);
}
