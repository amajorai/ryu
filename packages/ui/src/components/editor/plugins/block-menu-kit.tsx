"use client";

import { BlockMenuPlugin } from "@platejs/selection/react";

import { BlockContextMenu } from "@ryu/ui/components/editor/ui/block-context-menu.tsx";

import { BlockSelectionKit } from "./block-selection-kit.tsx";

export const BlockMenuKit = [
	...BlockSelectionKit,
	BlockMenuPlugin.configure({
		render: { aboveEditable: BlockContextMenu },
	}),
];
