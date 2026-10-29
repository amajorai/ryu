import { BaseSuggestionPlugin } from "@platejs/suggestion";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva } from "class-variance-authority";
import type { SlateEditor, TElement, TSuggestionText } from "platejs";
import type { SlateLeafProps } from "platejs/static";
import { SlateLeaf } from "platejs/static";

export const voidRemoveSuggestionClass =
	'relative overflow-hidden before:pointer-events-none before:absolute before:top-1/2 before:left-1/2 before:z-20 before:flex before:size-10 before:-translate-x-1/2 before:-translate-y-1/2 before:items-center before:justify-center before:rounded-full before:bg-destructive/90 before:text-2xl before:font-medium before:text-white before:shadow-lg before:content-["X"] after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:border after:border-destructive/80 after:bg-primary/35 after:content-[""]';

export const voidRemoveSuggestionOverlayVariants = cva(
	"pointer-events-none absolute inset-0 z-20 overflow-hidden rounded-[inherit]",
	{
		defaultVariants: {
			active: false,
		},
		variants: {
			active: {
				false: "hidden",
				true: 'before:pointer-events-none before:absolute before:start-1/2 before:top-1/2 before:z-20 before:flex before:size-10 before:-translate-x-1/2 before:-translate-y-1/2 before:items-center before:justify-center before:rounded-full before:bg-destructive/90 before:font-medium before:text-2xl before:text-white before:shadow-lg before:content-["X"] after:pointer-events-none after:absolute after:inset-0 after:z-10 after:rounded-[inherit] after:border after:border-destructive/80 after:bg-primary/35 after:content-[""] rtl:before:translate-x-1/2',
			},
		},
	}
);

export const voidRemoveSuggestionVariants = cva("", {
	defaultVariants: {
		active: false,
	},
	variants: {
		active: {
			false: "",
			true: voidRemoveSuggestionClass,
		},
	},
});

export function isStaticVoidRemoveSuggestion(element: TElement) {
	// SAFETY: Plate Suggestion adds optional metadata to the original element; this read preserves the complete native element and its optional removal flag.
	return (
		(element as TElement & { suggestion?: { type?: string } }).suggestion
			?.type === "remove"
	);
}

export function VoidRemoveSuggestionOverlayStatic({
	editor,
	element,
}: {
	editor: SlateEditor;
	element: TElement;
}) {
	const active =
		editor.api.isVoid(element) &&
		!editor.api.isInline(element) &&
		isStaticVoidRemoveSuggestion(element);

	if (!active) {
		return null;
	}

	return (
		<div
			className={voidRemoveSuggestionOverlayVariants({ active })}
			contentEditable={false}
			data-slot="void-remove-suggestion"
		/>
	);
}

export function SuggestionLeafStatic(props: SlateLeafProps) {
	const { editor, leaf } = props;

	// SAFETY: Plate dataList types its parameter as a marked TSuggestionText, but natively enumerates only suggestion_* keys on the complete text object. SlateLeafProps supplies the full native text leaf; all raw marks, getters and the original method receiver remain unchanged.
	const dataList = editor
		.getApi(BaseSuggestionPlugin)
		.suggestion.dataList(leaf as TSuggestionText);
	const hasRemove = dataList.some((data) => data.type === "remove");
	const diffOperation = { type: hasRemove ? "delete" : "insert" } as const;

	const Component = ({ delete: "del", insert: "ins", update: "span" } as const)[
		diffOperation.type
	];

	return (
		<SlateLeaf
			{...props}
			as={Component}
			className={cn(
				"border-b-2 border-b-primary/[.24] bg-primary/[.08] text-primary/80 no-underline transition-colors duration-200",
				hasRemove &&
					"border-b-border bg-muted/25 text-muted-foreground line-through"
			)}
		>
			{props.children}
		</SlateLeaf>
	);
}
