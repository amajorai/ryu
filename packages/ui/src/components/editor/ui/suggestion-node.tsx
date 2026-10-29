"use client";

import { SuggestionPlugin } from "@platejs/suggestion/react";
import type { SuggestionConfig } from "@ryu/ui/components/editor/plugins/suggestion-kit.tsx";
import { voidRemoveSuggestionOverlayVariants } from "@ryu/ui/components/editor/ui/suggestion-node-static.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva } from "class-variance-authority";
import { CornerDownLeftIcon } from "lucide-react";
import type {
	TElement,
	TSuggestionData,
	TSuggestionText,
	WithRequiredKey,
} from "platejs";
import { KEYS } from "platejs";
import type {
	PlateEditor,
	PlateLeafProps,
	PlatePluginConfig,
} from "platejs/react";
import { PlateLeaf, useEditorPlugin, usePluginOption } from "platejs/react";
import {
	Children,
	type ComponentProps,
	cloneElement,
	isValidElement,
	type ReactElement,
	type ReactNode,
} from "react";
import { isNativeText } from "../../../lib/native-primitive-observation.ts";

// SAFETY: This native plugin object is used only as the registered suggestion key for Plate hook lookups. suggestion-kit owns the matching activeId/hoverId options; the installed hooks resolve editor.plugins by that key rather than reading those options from this SDK token. This does not assert that the raw SDK plugin itself carries the custom options.
const suggestionPlugin = SuggestionPlugin as WithRequiredKey<SuggestionConfig>;

export const suggestionVariants = cva(
	cn(
		"bg-success/10 text-status-success no-underline transition-colors duration-200"
	),
	{
		defaultVariants: {
			insertActive: false,
			remove: false,
			removeActive: false,
		},
		variants: {
			insertActive: {
				false: "",
				true: "bg-success/20",
			},
			remove: {
				false: "",
				true: "bg-destructive/10 text-status-destructive",
			},
			removeActive: {
				false: "",
				true: "bg-destructive/20 no-underline",
			},
		},
	}
);

export function getBlockSuggestionWrapperClassName({
	elementType,
	isActive,
	isHover,
	isInsert,
	isRemove,
}: {
	elementType?: string;
	isActive: boolean;
	isHover: boolean;
	isInsert: boolean;
	isRemove: boolean;
}) {
	return cn(
		elementType === KEYS.columnGroup && "flex size-full rounded",
		suggestionVariants({
			insertActive: isInsert && (isActive || isHover),
			remove: isRemove,
			removeActive: (isActive || isHover) && isRemove,
		})
	);
}

export function isVoidRemoveSuggestion(editor: PlateEditor, element: TElement) {
	return (
		editor.getApi(SuggestionPlugin).suggestion.suggestionData(element)?.type ===
		"remove"
	);
}

export function VoidRemoveSuggestionOverlay({
	editor,
	element,
}: {
	editor: PlateEditor;
	element: TElement;
}) {
	const active =
		editor.api.isVoid(element) &&
		!editor.api.isInline(element) &&
		isVoidRemoveSuggestion(editor, element);

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

export function SuggestionLineBreakAnchor({
	badgeProps,
	children,
	className,
}: {
	badgeProps?: ComponentProps<"span">;
	children: ReactNode;
	className?: string;
}) {
	const badge = (
		<span
			{...badgeProps}
			className={cn(
				"inline-flex h-[calc(1lh+2px)] w-[1lh] shrink-0 items-center justify-center leading-none",
				badgeProps?.className,
				className
			)}
			contentEditable={false}
		>
			<CornerDownLeftIcon className="relative top-px size-4" />
		</span>
	);

	return (
		<>
			{children}
			{badge}
		</>
	);
}

function SuggestionLineBreakElementAnchor({
	badgeProps,
	children,
	className,
}: {
	badgeProps?: ComponentProps<"span">;
	children: ReactElement<any>;
	className?: string;
}) {
	if (!isValidElement<typeof children.props>(children)) {
		return children;
	}
	const badge = (
		<span
			{...badgeProps}
			className={cn(
				"inline-flex h-[calc(1lh+2px)] w-[1lh] shrink-0 items-center justify-center leading-none",
				badgeProps?.className,
				className
			)}
			contentEditable={false}
		>
			<CornerDownLeftIcon className="relative top-px size-4" />
		</span>
	);

	if (children.type === "ol" || children.type === "ul") {
		const childNodes = Children.toArray(children.props.children);
		const lastIndex = childNodes.length - 1;
		const lastChild = childNodes[lastIndex];

		if (
			!isValidElement<ComponentProps<"li">>(lastChild) ||
			lastChild.type !== "li"
		) {
			return children;
		}

		const nextLastChild = cloneElement(lastChild, {
			children: (
				<>
					{lastChild.props.children}
					{badge}
				</>
			),
		});

		return cloneElement(children, {
			children: [...childNodes.slice(0, lastIndex), nextLastChild],
		});
	}

	if (isNativeText(children.type)) {
		return (
			<>
				{children}
				{badge}
			</>
		);
	}

	return cloneElement(children, {
		lineBreakBadge: badge,
	});
}

export function SuggestionLeaf(props: PlateLeafProps<TSuggestionText>) {
	const { api, setOption } = useEditorPlugin(suggestionPlugin);
	const leaf = props.leaf;

	const leafId: string = api.suggestion.nodeId(leaf) ?? "";
	const activeSuggestionId = usePluginOption(suggestionPlugin, "activeId");
	const hoverSuggestionId = usePluginOption(suggestionPlugin, "hoverId");
	const dataList = api.suggestion.dataList(leaf);

	const hasRemove = dataList.some((data) => data.type === "remove");
	const hasActive = dataList.some((data) => data.id === activeSuggestionId);
	const hasHover = dataList.some((data) => data.id === hoverSuggestionId);

	const diffOperation = { type: hasRemove ? "delete" : "insert" } as const;

	const Component = ({ delete: "del", insert: "ins", update: "span" } as const)[
		diffOperation.type
	];

	return (
		<PlateLeaf
			{...props}
			as={Component}
			attributes={{
				...props.attributes,
				onMouseEnter: () => setOption("hoverId", leafId),
				onMouseLeave: () => setOption("hoverId", null),
			}}
			className={cn(
				suggestionVariants({
					insertActive: hasActive || hasHover,
					remove: hasRemove,
					removeActive: (hasActive || hasHover) && hasRemove,
				})
			)}
		>
			{props.children}
		</PlateLeaf>
	);
}
type SuggestionRenderConfig = PlatePluginConfig<
	SuggestionConfig["key"],
	SuggestionConfig["options"],
	SuggestionConfig["api"],
	SuggestionConfig["transforms"],
	SuggestionConfig["selectors"]
>;

export const SuggestionLineBreak: NonNullable<
	NonNullable<SuggestionRenderConfig["render"]>["belowNodes"]
> = ({ api, element }) => {
	if (!api.suggestion.isBlockSuggestion(element)) {
		return;
	}

	const suggestionData = element.suggestion;

	return function Component({ children }) {
		return (
			<SuggestionLineBreakContent
				elementType={element.type}
				suggestionData={suggestionData}
			>
				{children}
			</SuggestionLineBreakContent>
		);
	};
};

export function SuggestionLineBreakContent({
	children,
	elementType,
	suggestionData,
}: {
	children: ReactNode;
	elementType?: string;
	suggestionData: TSuggestionData;
}) {
	const { isLineBreak, type } = suggestionData;
	const isRemove = type === "remove";
	const isInsert = type === "insert";

	const activeSuggestionId = usePluginOption(suggestionPlugin, "activeId");
	const hoverSuggestionId = usePluginOption(suggestionPlugin, "hoverId");

	const isActive = activeSuggestionId === suggestionData.id;
	const isHover = hoverSuggestionId === suggestionData.id;

	const { setOption } = useEditorPlugin(suggestionPlugin);
	const lineBreakBadgeClassName = cn(
		isInsert &&
			"bg-transparent! text-status-success! transition-colors duration-200",
		isInsert && (isActive || isHover) && "bg-transparent! text-status-success!",
		isRemove &&
			"bg-transparent! text-status-destructive! transition-colors duration-200",
		isRemove &&
			(isActive || isHover) &&
			"bg-transparent! text-status-destructive!"
	);

	return (
		<>
			{isLineBreak ? (
				isValidElement(children) && !isNativeText(children.type) ? (
					<SuggestionLineBreakElementAnchor
						badgeProps={{
							onClick: (event) => {
								event.stopPropagation();
								setOption("activeId", suggestionData.id);
							},
							onMouseDown: (event) => {
								event.preventDefault();
							},
						}}
						className={lineBreakBadgeClassName}
					>
						{children}
					</SuggestionLineBreakElementAnchor>
				) : isValidElement(children) &&
					(children.type === "ol" || children.type === "ul") ? (
					<SuggestionLineBreakElementAnchor
						badgeProps={{
							onClick: (event) => {
								event.stopPropagation();
								setOption("activeId", suggestionData.id);
							},
							onMouseDown: (event) => {
								event.preventDefault();
							},
						}}
						className={lineBreakBadgeClassName}
					>
						{children}
					</SuggestionLineBreakElementAnchor>
				) : (
					<SuggestionLineBreakAnchor
						badgeProps={{
							onClick: (event) => {
								event.stopPropagation();
								setOption("activeId", suggestionData.id);
							},
							onMouseDown: (event) => {
								event.preventDefault();
							},
						}}
						className={lineBreakBadgeClassName}
					>
						{children}
					</SuggestionLineBreakAnchor>
				)
			) : (
				<div
					className={getBlockSuggestionWrapperClassName({
						elementType,
						isActive,
						isHover,
						isInsert,
						isRemove,
					})}
					data-block-suggestion="true"
					onMouseEnter={() => setOption("hoverId", suggestionData.id)}
					onMouseLeave={() => setOption("hoverId", null)}
				>
					{children}
				</div>
			)}
		</>
	);
}
