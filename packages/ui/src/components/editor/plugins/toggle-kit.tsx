"use client";

import { TogglePlugin } from "@platejs/toggle/react";

import { IndentKit } from "@ryu/ui/components/editor/plugins/indent-kit.tsx";
import { ToggleElement } from "@ryu/ui/components/editor/ui/toggle-node.tsx";

export const ToggleKit = [
	...IndentKit,
	TogglePlugin.withComponent(ToggleElement),
];
