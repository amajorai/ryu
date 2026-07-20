"use client";

import { LinkRules } from "@platejs/link";
import { LinkPlugin } from "@platejs/link/react";

import { LinkElement } from "@ryu/ui/components/editor/ui/link-node.tsx";
import { LinkFloatingToolbar } from "@ryu/ui/components/editor/ui/link-toolbar.tsx";

export const LinkKit = [
	LinkPlugin.configure({
		inputRules: [
			LinkRules.markdown(),
			LinkRules.autolink({ variant: "paste" }),
			LinkRules.autolink({ variant: "space" }),
			LinkRules.autolink({ variant: "break" }),
		],
		render: {
			node: LinkElement,
			afterEditable: () => <LinkFloatingToolbar />,
		},
	}),
];
