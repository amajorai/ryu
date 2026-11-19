"use client";

import { IndentPlugin } from "@platejs/indent/react";
import { KEYS } from "platejs";

// The editable indents on the inline-start edge so RTL blocks indent from the
// right. `indent-base-kit.tsx` keeps the physical `marginLeft` because DOCX
// export reads it.
export const IndentKit = [
	IndentPlugin.configure({
		inject: {
			nodeProps: { styleKey: "marginInlineStart" },
			targetPlugins: [
				...KEYS.heading,
				KEYS.p,
				KEYS.blockquote,
				KEYS.codeBlock,
				KEYS.toggle,
				KEYS.img,
			],
		},
		options: {
			offset: 24,
		},
	}),
];
