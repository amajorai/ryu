"use client";

import {
	FloatingMedia as FloatingMediaPrimitive,
	FloatingMediaStore,
	useFloatingMediaValue,
	useImagePreviewValue,
} from "@platejs/media/react";
import {
	Button,
	buttonVariants,
} from "@ryu/ui/components/editor/ui/button.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { Separator } from "@ryu/ui/components/editor/ui/separator.tsx";
import { cva } from "class-variance-authority";
import { Link, Trash2Icon } from "lucide-react";
import type { WithRequiredKey } from "platejs";
import {
	useEditorRef,
	useEditorSelector,
	useElement,
	useFocusedLast,
	useReadOnly,
	useRemoveNodeButton,
	useSelected,
} from "platejs/react";
import { type ReactNode, useEffect } from "react";

import { CaptionButton } from "./caption.tsx";

const inputVariants = cva(
	"flex h-[28px] w-full rounded-md border-none bg-transparent px-1.5 py-1 text-base placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-transparent md:text-sm"
);

export function MediaToolbar({
	children,
	plugin,
}: {
	children: ReactNode;
	plugin: WithRequiredKey;
}) {
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const selected = useSelected();
	const isFocusedLast = useFocusedLast();
	const selectionCollapsed = useEditorSelector(
		(editor) => !editor.api.isExpanded(),
		[]
	);
	const isImagePreviewOpen = useImagePreviewValue("isOpen", editor.id);
	const open =
		isFocusedLast &&
		!readOnly &&
		selected &&
		selectionCollapsed &&
		!isImagePreviewOpen;
	const isEditing = useFloatingMediaValue("isEditing");

	useEffect(() => {
		if (!open && isEditing) {
			FloatingMediaStore.set("isEditing", false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, isEditing]);

	const element = useElement();
	const { props: buttonProps } = useRemoveNodeButton({ element });

	return (
		<Popover modal={false} open={open}>
			<PopoverAnchor>{children}</PopoverAnchor>

			<PopoverContent
				className="w-auto p-1"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{isEditing ? (
					<div className="flex w-[330px] flex-col">
						<div className="flex items-center">
							<div className="flex items-center pr-1 pl-2 text-muted-foreground">
								<Link className="size-4" />
							</div>

							<FloatingMediaPrimitive.UrlInput
								className={inputVariants()}
								options={{ plugin }}
								placeholder="Paste the embed link..."
							/>
						</div>
					</div>
				) : (
					<div className="box-content flex items-center">
						<FloatingMediaPrimitive.EditButton
							className={buttonVariants({ size: "sm", variant: "ghost" })}
						>
							Edit link
						</FloatingMediaPrimitive.EditButton>

						<CaptionButton size="sm" variant="ghost">
							Caption
						</CaptionButton>

						<Separator className="mx-1 h-6" orientation="vertical" />

						<Button size="sm" variant="ghost" {...buttonProps}>
							<Trash2Icon />
						</Button>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
