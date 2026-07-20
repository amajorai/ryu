import { BaseListPlugin, isOrderedList } from "@platejs/list";
import { BaseIndentKit } from "@ryu/ui/components/editor/plugins/indent-base-kit.tsx";
import { BlockListStatic } from "@ryu/ui/components/editor/ui/block-list-static.tsx";
import { KEYS } from "platejs";

export const BaseListKit = [
	...BaseIndentKit,
	BaseListPlugin.configure({
		inject: {
			nodeProps: {
				nodeKey: KEYS.listType,
				query: ({ nodeProps }) => {
					const element = nodeProps.element;

					return !!element?.listStyleType && !isOrderedList(element);
				},
				transformProps: ({ props }) => ({
					...props,
					role: "listitem",
					style: {
						...props.style,
						display: "list-item",
					},
				}),
			},
			targetPlugins: [
				...KEYS.heading,
				KEYS.p,
				KEYS.blockquote,
				KEYS.codeBlock,
				KEYS.toggle,
			],
		},
		render: {
			belowNodes: BlockListStatic,
		},
	}),
];
