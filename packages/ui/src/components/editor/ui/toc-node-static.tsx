import { isNativeNumber } from "@ryu/ui/lib/native-primitive-observation.ts";
import type { CSSProperties as ReactCSSProperties } from "react";
import "../docx-nodes.css";
import { BaseTocPlugin, type Heading, isHeading } from "@platejs/toc";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import { cva } from "class-variance-authority";
import { NodeApi, type SlateEditor, type TElement } from "platejs";
import type { SlateElementProps } from "platejs/static";
import { SlateElement } from "platejs/static";

interface EditorVariableStyle extends ReactCSSProperties {
	"--editortocNodeStatic2-margin-left"?: string | number;
}

const headingItemVariants = cva(
	"block h-auto w-full cursor-pointer truncate rounded-none px-0.5 py-1.5 text-start font-medium text-muted-foreground underline decoration-[0.5px] underline-offset-4 hover:bg-accent hover:text-muted-foreground",
	{
		variants: {
			depth: {
				1: "ps-0.5",
				2: "ps-[26px]",
				3: "ps-[50px]",
			},
		},
	}
);

export function TocElementStatic(props: SlateElementProps) {
	const { editor } = props;
	const headingList = getHeadingList(editor);

	return (
		<SlateElement {...props} className="mb-1 p-0">
			<div>
				{headingList.length > 0 ? (
					headingList.map((item: Heading) => (
						<Button
							className={headingItemVariants({
								// SAFETY: Installed cva indexes its actual variant table and omits
								// unknown keys. The native Heading depth is forwarded unchanged:
								// only 1/2/3 add spacing; 4/5/6 and custom depths keep the
								// existing no-depth-class fallback. No closed-set membership is proved.
								depth: item.depth as 1 | 2 | 3,
							})}
							key={item.title}
							variant="ghost"
						>
							{item.title}
						</Button>
					))
				) : (
					<div className="text-muted-foreground text-sm">
						Create a heading to display the table of contents.
					</div>
				)}
			</div>
			{props.children}
		</SlateElement>
	);
}

const headingDepth = new Map<string, number>([
	["h1", 1],
	["h2", 2],
	["h3", 3],
	["h4", 4],
	["h5", 5],
	["h6", 6],
]);

const getHeadingList = (editor?: SlateEditor) => {
	if (!editor) {
		return [];
	}

	const options = editor.getOptions(BaseTocPlugin);

	if (options.queryHeading) {
		return options.queryHeading(editor);
	}

	const headingList: Heading[] = [];

	const values = editor.api.nodes<TElement>({
		at: [],
		match: (n) => isHeading(n),
	});

	if (!values) {
		return [];
	}

	Array.from(values).forEach(([node, path]) => {
		const { type } = node;
		const title = NodeApi.string(node);
		const depth = headingDepth.get(type);
		// SAFETY: Plate heading IDs are authored by its NodeId plugin and forwarded unchanged to internal bookmark links.
		const id = node.id as string;

		if (title && depth !== undefined) {
			headingList.push({ id, depth, path, title, type });
		}
	});

	return headingList;
};

/**
 * DOCX-compatible TOC component.
 * Renders TOC items as anchor links for proper Word internal navigation.
 */
export function TocElementDocx(props: SlateElementProps) {
	const { editor } = props;
	const headingList = getHeadingList(editor);

	const depthIndent = new Map<number, string>([
		[1, "0"],
		[2, "24pt"],
		[3, "48pt"],
	]);

	return (
		<SlateElement {...props}>
			<div data-docx-style="editortocNodeStatic1">
				{headingList.length > 0 ? (
					headingList.map((item: Heading) => {
						const editortocNodeStatic2Style: EditorVariableStyle = {
							"--editortocNodeStatic2-margin-left": isNativeNumber(
								depthIndent.get(item.depth) || "0"
							)
								? `${depthIndent.get(item.depth) || "0"}px`
								: depthIndent.get(item.depth) || "0",
						};
						return (
							<p
								data-docx-style="editortocNodeStatic2"
								key={item.id}
								style={editortocNodeStatic2Style}
							>
								<a data-docx-style="editortocNodeStatic3" href={`#${item.id}`}>
									{item.title}
								</a>
							</p>
						);
					})
				) : (
					<p data-docx-style="editortocNodeStatic4">
						Create a heading to display the table of contents.
					</p>
				)}
			</div>
			{props.children}
		</SlateElement>
	);
}
