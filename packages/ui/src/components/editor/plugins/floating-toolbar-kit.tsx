"use client";

import { FloatingToolbar } from "@ryu/ui/components/editor/ui/floating-toolbar.tsx";
import { FloatingToolbarButtons } from "@ryu/ui/components/editor/ui/floating-toolbar-buttons.tsx";
import { createPlatePlugin } from "platejs/react";

export const FloatingToolbarKit = [
	createPlatePlugin({
		key: "floating-toolbar",
		render: {
			afterEditable: () => (
				<FloatingToolbar>
					<FloatingToolbarButtons />
				</FloatingToolbar>
			),
		},
	}),
];
