"use client";

import { type LiteralMessage, useLiteralMessages } from "@ryu/i18n/react";
import { KEYS, type TElement } from "platejs";
import { BlockPlaceholderPlugin, usePluginOption } from "platejs/react";

const PARAGRAPH_PLACEHOLDER = "Type something…";

// The placeholder renders through CSS `attr(placeholder)` on a block inside the
// editable, which the DOM localizer never reaches, so translate it here. Each
// default is spelled out in a literal tl() call so the extractor sees it.
function localizedPlaceholder(tl: LiteralMessage, placeholder: string): string {
	if (placeholder === PARAGRAPH_PLACEHOLDER) {
		return tl("Type something…");
	}
	return tl(placeholder);
}

export const BlockPlaceholderKit = [
	BlockPlaceholderPlugin.configure({
		options: {
			className:
				"before:absolute before:cursor-text before:text-muted-foreground/80 before:content-[attr(placeholder)]",
			placeholders: {
				[KEYS.p]: PARAGRAPH_PLACEHOLDER,
			},
			query: ({ path }) => path.length === 1,
		},
	}).extend({
		inject: {
			nodeProps: {
				// Same contract as the plugin's own transform, with the
				// placeholder translated into the reader's language.
				transformProps: (props) => {
					// SAFETY: the plugin injects block props only (`isBlock`), so the
					// transform always runs for a rendered element, as upstream assumes.
					const placeholder = usePluginOption(
						props.plugin,
						"placeholder",
						props.element as TElement
					) as string | undefined;
					const tl = useLiteralMessages();
					if (!placeholder) {
						return;
					}
					return {
						className: props.getOption("className"),
						placeholder: localizedPlaceholder(tl, placeholder),
					};
				},
			},
		},
	}),
];
