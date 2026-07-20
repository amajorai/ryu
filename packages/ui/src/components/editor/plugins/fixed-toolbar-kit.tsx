"use client";

import { FixedToolbar } from "@ryu/ui/components/editor/ui/fixed-toolbar.tsx";
import { FixedToolbarButtons } from "@ryu/ui/components/editor/ui/fixed-toolbar-buttons.tsx";
import { createPlatePlugin } from "platejs/react";

export const FixedToolbarKit = [
	createPlatePlugin({
		key: "fixed-toolbar",
		render: {
			beforeEditable: () => (
				<FixedToolbar>
					<FixedToolbarButtons />
				</FixedToolbar>
			),
		},
	}),
];
