"use client";

import type { TFootnoteElement } from "@platejs/footnote";
import { FootnoteReferencePlugin } from "@platejs/footnote/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/editor/ui/command.tsx";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@ryu/ui/components/editor/ui/hover-card.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { type Path, PathApi } from "platejs";
import type { PlateEditor, PlateElementProps } from "platejs/react";
import {
	PlateElement,
	useEditorSelector,
	useFocused,
	useNavigationHighlight,
	usePath,
	useSelected,
} from "platejs/react";
import { type CSSProperties, useState } from "react";

interface FootnoteNavigationStyle extends CSSProperties {
	"--plate-nav-feedback-duration"?: string | undefined;
}

const getNavigationAttributes = (
	attributes: PlateElementProps<TFootnoteElement>["attributes"],
	navigationHighlight: ReturnType<typeof useNavigationHighlight>
) => ({
	...attributes,
	"data-nav-cycle": navigationHighlight
		? String(navigationHighlight.cycle)
		: undefined,
	"data-nav-highlight": navigationHighlight?.variant,
	"data-nav-pulse": navigationHighlight
		? String(navigationHighlight.pulse)
		: undefined,
	"data-nav-target": navigationHighlight ? "true" : undefined,
	style: {
		...attributes.style,
		["--plate-nav-feedback-duration" as const]: navigationHighlight
			? `${navigationHighlight.duration}ms`
			: undefined,
	} satisfies FootnoteNavigationStyle,
});

const getReferenceContextLabel = (
	editor: PlateEditor,
	path: Path,
	index: number
) => {
	const parentEntry = editor.api.parent(path);
	const fallback = `Reference ${index + 1}`;

	if (!parentEntry) {
		return fallback;
	}

	const text = editor.api.string(parentEntry[1]);
	const normalized = text.replace(/\s+/g, " ").trim();

	if (!normalized) {
		return fallback;
	}

	return normalized.length > 56
		? `${normalized.slice(0, 53).trimEnd()}...`
		: normalized;
};

export function FootnoteReferenceElement(
	props: PlateElementProps<TFootnoteElement>
) {
	const { editor, element } = props;
	const identifier = element.identifier ?? "";
	const footnoteApi = editor.getApi(FootnoteReferencePlugin).footnote;
	const footnoteTransforms = editor.getTransforms(
		FootnoteReferencePlugin
	).footnote;
	const tl = useLiteralMessages();
	const [hoverOpen, setHoverOpen] = useState(false);
	const focused = useFocused();
	const path = usePath();
	const navigationHighlight = useNavigationHighlight(path);
	const fallbackResolved =
		identifier && footnoteApi ? footnoteApi.isResolved({ identifier }) : false;
	const fallbackPreviewText =
		identifier && footnoteApi
			? footnoteApi.definitionText({ identifier })
			: undefined;
	const livePreview = useEditorSelector(() => {
		if (!(hoverOpen && identifier)) {
			return null;
		}

		return {
			isResolved: footnoteApi.isResolved({ identifier }),
			previewText: footnoteApi.definitionText({ identifier }),
		};
	}, [hoverOpen, identifier]);
	const isResolved = livePreview?.isResolved ?? fallbackResolved;
	const previewText = livePreview?.previewText ?? fallbackPreviewText;
	const selected = useSelected();
	const isSelectionInsideAtom = useEditorSelector(
		(currentEditor) => {
			const selection = currentEditor.selection;

			if (!(path && selection)) {
				return false;
			}

			return (
				PathApi.equals(selection.anchor.path, path.concat([0])) &&
				PathApi.equals(selection.focus.path, path.concat([0])) &&
				selection.anchor.offset === selection.focus.offset
			);
		},
		[path]
	);

	return (
		<PlateElement
			{...props}
			as="sup"
			attributes={{
				...getNavigationAttributes(props.attributes, navigationHighlight),
				contentEditable: false,
				draggable: true,
			}}
			className="group/footnote-ref mx-0.5 align-super"
		>
			{props.children}
			<HoverCard onOpenChange={setHoverOpen} open={hoverOpen}>
				<HoverCardTrigger
					render={
						<button
							className={cn(
								"cursor-pointer rounded-xs font-medium text-primary text-xs focus:ring-2 focus:ring-ring focus:ring-offset-1 group-data-[nav-target=true]/footnote-ref:bg-(--color-highlight)",
								(selected && focused) || isSelectionInsideAtom
									? "ring-2 ring-ring ring-offset-1"
									: null
							)}
							onClick={(event) => {
								event.preventDefault();
								event.stopPropagation();
							}}
							onMouseDown={(event) => {
								if (event.metaKey || event.ctrlKey) {
									event.preventDefault();
									event.stopPropagation();
									if (isResolved) {
										footnoteTransforms.focusDefinition({ identifier });

										return;
									}

									footnoteTransforms.createDefinition({ identifier });
								}
							}}
							type="button"
						/>
					}
				>
					[{identifier}]
				</HoverCardTrigger>
				{previewText ? (
					<HoverCardContent className="w-80">
						<div className="space-y-1">
							<div className="text-muted-foreground text-sm leading-relaxed">
								{previewText}
							</div>
						</div>
					</HoverCardContent>
				) : identifier ? (
					<HoverCardContent className="w-80">
						<div className="space-y-2">
							{isResolved ? (
								<div className="text-sm leading-relaxed">
									No preview available.
								</div>
							) : (
								<Button
									className="type-caption h-6 rounded-xs px-2"
									onMouseDown={(event) => {
										event.preventDefault();
										event.stopPropagation();
										footnoteTransforms.createDefinition({ identifier });
										setHoverOpen(false);
									}}
									size="sm"
									type="button"
									variant="outline"
								>
									{tl("Create definition for [^{identifier}]", { identifier })}
								</Button>
							)}
						</div>
					</HoverCardContent>
				) : null}
			</HoverCard>
		</PlateElement>
	);
}

export function FootnoteDefinitionElement(
	props: PlateElementProps<TFootnoteElement>
) {
	const { editor, element } = props;
	const identifier = element.identifier ?? "";
	const footnoteApi = editor.getApi(FootnoteReferencePlugin).footnote;
	const footnoteTransforms = editor.getTransforms(
		FootnoteReferencePlugin
	).footnote;
	const tl = useLiteralMessages();
	const path = usePath();
	const definitionState = useEditorSelector(() => {
		const isDuplicateDefinition =
			!!path && !!footnoteApi.isDuplicateDefinition?.({ path });
		const referenceItems =
			!isDuplicateDefinition && identifier
				? footnoteApi
						.references({ identifier })
						.map((entry: any, index: number) => ({
							index,
							label: getReferenceContextLabel(editor, entry[1], index),
						}))
				: [];

		return {
			duplicateReplacementIdentifier: isDuplicateDefinition
				? footnoteApi.nextId?.()
				: undefined,
			isDuplicateDefinition,
			path,
			referenceItems,
		};
	}, [identifier, path]);
	const navigationHighlight = useNavigationHighlight(definitionState?.path);
	const isDuplicateDefinition = !!definitionState?.isDuplicateDefinition;
	const duplicateReplacementIdentifier =
		definitionState?.duplicateReplacementIdentifier;
	const [referencePickerOpen, setReferencePickerOpen] = useState(false);
	const referenceItems = definitionState?.referenceItems ?? [];
	const hasMultipleReferences = referenceItems.length > 1;

	return (
		<PlateElement
			{...props}
			attributes={getNavigationAttributes(
				props.attributes,
				navigationHighlight
			)}
			className={cn(
				"mt-1.5 flex items-start gap-1.5 data-[nav-target=true]:rounded-md data-[nav-target=true]:bg-(--color-highlight)",
				isDuplicateDefinition &&
					"rounded-md border border-warning/30 bg-warning/5 px-2 py-2"
			)}
		>
			<div contentEditable={false}>
				{isDuplicateDefinition ? (
					<div className="min-w-3 text-status-warning text-xs tabular-nums">
						{identifier}
					</div>
				) : (
					<Popover
						onOpenChange={setReferencePickerOpen}
						open={referencePickerOpen}
					>
						<PopoverAnchor>
							<button
								aria-expanded={
									hasMultipleReferences ? referencePickerOpen : undefined
								}
								aria-haspopup={hasMultipleReferences ? "dialog" : undefined}
								aria-label={tl("Back to reference {identifier}", {
									identifier,
								})}
								className="min-w-3 cursor-pointer rounded-xs text-muted-foreground text-xs tabular-nums underline-offset-2 hover:text-foreground focus:ring-2 focus:ring-ring focus:ring-offset-1"
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
								}}
								onMouseDown={(event) => {
									event.preventDefault();
									event.stopPropagation();

									if (hasMultipleReferences) {
										setReferencePickerOpen((open) => !open);

										return;
									}

									footnoteTransforms.focusReference({ identifier });
								}}
								type="button"
							>
								{identifier}
							</button>
						</PopoverAnchor>

						{hasMultipleReferences && referencePickerOpen ? (
							<PopoverContent
								align="start"
								className="w-72 p-0"
								onCloseAutoFocus={(event) => event.preventDefault()}
								onOpenAutoFocus={(event) => event.preventDefault()}
								sideOffset={8}
							>
								<Command>
									<CommandList>
										<CommandGroup>
											{referenceItems.map(
												(item: { index: number; label: string }) => (
													<CommandItem
														className="cursor-pointer gap-2"
														key={`${identifier}-${item.index}`}
														onMouseDown={(event) => event.preventDefault()}
														onSelect={() => {
															setReferencePickerOpen(false);
															footnoteTransforms.focusReference({
																identifier,
																index: item.index,
															});
														}}
													>
														<span className="font-mono text-muted-foreground text-xs">
															{item.index + 1}
														</span>
														<span className="truncate">{item.label}</span>
													</CommandItem>
												)
											)}
										</CommandGroup>
									</CommandList>
								</Command>
							</PopoverContent>
						) : null}
					</Popover>
				)}
			</div>
			<div className="min-w-0 flex-1">
				{isDuplicateDefinition ? (
					<div
						className="mb-2 flex flex-wrap items-center gap-2"
						contentEditable={false}
					>
						{duplicateReplacementIdentifier && path ? (
							<Button
								className="type-caption h-6 rounded-xs border-warning/40 px-2 text-status-warning hover:bg-warning/10 hover:text-status-warning"
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
								}}
								onMouseDown={(event) => {
									event.preventDefault();
									event.stopPropagation();
									footnoteTransforms.normalizeDuplicateDefinition({
										identifier: duplicateReplacementIdentifier,
										path,
									});
								}}
								size="sm"
								type="button"
								variant="outline"
							>
								{tl("Renumber to [^{duplicateReplacementIdentifier}]", {
									duplicateReplacementIdentifier,
								})}
							</Button>
						) : null}
					</div>
				) : null}
				{props.children}
			</div>
		</PlateElement>
	);
}

export { FootnoteInputElement } from "./footnote-node-input.tsx";
