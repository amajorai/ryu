"use client";

import {
	Add01Icon,
	BubbleChatIcon,
	Delete01Icon,
	Image01Icon,
	PencilEdit01Icon,
	Refresh01Icon,
	Search01Icon,
	Settings01Icon,
	Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { OverflowActionItem } from "@ryu/ui/components/overflow-actions.tsx";
import type { ImageEditorController } from "./ImageEditorDialog-interactions.ts";
import type { ImageEditorAsset } from "./ImageEditorDialog-types.ts";

export function buildImageEditorActions(
	editor: ImageEditorController,
	{
		image,
		onOpenDrawesome,
	}: {
		image: ImageEditorAsset;
		onOpenDrawesome?: (image: ImageEditorAsset) => void;
	}
): {
	overflowActions: OverflowActionItem[];
	primaryActions: OverflowActionItem[];
} {
	const {
		editorReady,
		isBusy,
		modelSettingsOpen,
		paddingPanelOpen,
		removeBackground,
		resetImage,
		resizePanelOpen,
		runSegmentation,
		segments,
		setModelSettingsOpen,
		setPaddingPanelOpen,
		setResizePanelOpen,
		setTool,
		tool,
	} = editor;
	const primaryActions: OverflowActionItem[] = [
		{
			ariaLabel: "Markup brush",
			className:
				tool === "markup" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={PencilEdit01Icon} size={14} />,
			id: "markup",
			label: "Markup",
			pressed: tool === "markup",
			onClick: () => {
				setTool("markup");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		{
			ariaLabel: "Add comment",
			className:
				tool === "comment" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={BubbleChatIcon} size={14} />,
			id: "comment",
			label: "Comment",
			pressed: tool === "comment",
			onClick: () => {
				setTool("comment");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		{
			ariaLabel: "Remove background",
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Image01Icon} size={14} />,
			id: "remove-background",
			label: "Remove BG",
			onClick: () => void removeBackground(),
		},
		{
			ariaLabel: "Erase brush",
			className: tool === "erase" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Delete01Icon} size={14} />,
			id: "erase",
			label: "Erase",
			pressed: tool === "erase",
			onClick: () => {
				setTool("erase");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		{
			ariaLabel: "AI Resize",
			className: resizePanelOpen ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Square01Icon} size={14} />,
			id: "resize",
			label: "Resize",
			pressed: resizePanelOpen,
			onClick: () => {
				setResizePanelOpen((current) => !current);
				setPaddingPanelOpen(false);
				setModelSettingsOpen(false);
			},
		},
	];
	const overflowActions: OverflowActionItem[] = [
		{
			ariaLabel: "Select a detected subject",
			className:
				tool === "select" ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Search01Icon} size={14} />,
			id: "select-subject",
			label: "Select subject",
			pressed: tool === "select",
			onClick: () => {
				setTool("select");
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
				if (segments.length === 0) {
					void runSegmentation();
				}
			},
		},
		{
			ariaLabel: "Find subjects",
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Search01Icon} size={14} />,
			id: "find-subjects",
			label: "Find subjects",
			onClick: () => void runSegmentation(),
		},
		{
			ariaLabel: "Add transparent padding",
			className: paddingPanelOpen ? "bg-primary/10 text-foreground" : undefined,
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Add01Icon} size={14} />,
			id: "transparent-padding",
			label: "Transparent padding",
			pressed: paddingPanelOpen,
			onClick: () => {
				setPaddingPanelOpen((current) => !current);
				setResizePanelOpen(false);
				setModelSettingsOpen(false);
			},
		},
		{
			ariaLabel: "Reset image",
			disabled: !editorReady || isBusy,
			icon: <HugeiconsIcon icon={Refresh01Icon} size={14} />,
			id: "reset",
			label: "Reset",
			onClick: () => void resetImage(),
		},
		{
			ariaLabel: "Image model settings",
			className: modelSettingsOpen
				? "bg-primary/10 text-foreground"
				: undefined,
			icon: <HugeiconsIcon icon={Settings01Icon} size={14} />,
			id: "models",
			label: "Models",
			pressed: modelSettingsOpen,
			onClick: () => {
				setModelSettingsOpen((current) => !current);
				setResizePanelOpen(false);
				setPaddingPanelOpen(false);
			},
		},
		...(onOpenDrawesome
			? [
					{
						ariaLabel: "Open in Drawesome",
						id: "drawesome",
						label: "Drawesome",
						onClick: () => onOpenDrawesome(image),
					},
				]
			: []),
	];
	return { overflowActions, primaryActions };
}
