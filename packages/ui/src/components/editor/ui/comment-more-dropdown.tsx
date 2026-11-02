"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { discussionPlugin } from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { MoreHorizontalIcon, PencilIcon, TrashIcon } from "lucide-react";
import { useEditorRef } from "platejs/react";
import { type Dispatch, type SetStateAction, useCallback, useRef } from "react";
import { toast } from "../../sileo.tsx";
import { saveDiscussions, type TComment } from "./comment-shared.ts";

export function CommentMoreDropdown(props: {
	comment: TComment;
	dropdownOpen: boolean;
	setDropdownOpen: Dispatch<SetStateAction<boolean>>;
	setEditingId: Dispatch<SetStateAction<string | null>>;
	onCloseAutoFocus?: () => void;
	onRemoveComment?: () => void;
}) {
	const {
		comment,
		dropdownOpen,
		setDropdownOpen,
		setEditingId,
		onCloseAutoFocus,
		onRemoveComment,
	} = props;

	const editor = useEditorRef();
	const tl = useLiteralMessages();

	const selectedEditCommentRef = useRef<boolean>(false);

	const onDeleteComment = useCallback(() => {
		if (!comment.id) {
			toast.warning(
				tl("You are operating too quickly, please try again later.")
			);
			return;
		}

		// Find and update the discussion
		const updatedDiscussions = editor
			.getOption(discussionPlugin, "discussions")
			.map((discussion) => {
				if (discussion.id !== comment.discussionId) {
					return discussion;
				}

				const commentIndex = discussion.comments.findIndex(
					(c) => c.id === comment.id
				);
				if (commentIndex === -1) {
					return discussion;
				}

				return {
					...discussion,
					comments: [
						...discussion.comments.slice(0, commentIndex),
						...discussion.comments.slice(commentIndex + 1),
					],
				};
			});

		// Save back to session storage
		saveDiscussions(editor, updatedDiscussions);
		onRemoveComment?.();
	}, [comment.discussionId, comment.id, editor, onRemoveComment, tl]);

	const onEditComment = useCallback(() => {
		selectedEditCommentRef.current = true;

		if (!comment.id) {
			toast.warning(
				tl("You are operating too quickly, please try again later.")
			);
			return;
		}

		setEditingId(comment.id);
	}, [comment.id, setEditingId, tl]);

	return (
		<DropdownMenu
			modal={false}
			onOpenChange={setDropdownOpen}
			open={dropdownOpen}
		>
			<DropdownMenuTrigger
				onClick={(e) => e.stopPropagation()}
				render={
					<Button className={"h-6 p-1 text-muted-foreground"} variant="ghost" />
				}
			>
				<MoreHorizontalIcon className="size-4" />
			</DropdownMenuTrigger>
			<DropdownMenuContent
				className="w-48"
				onCloseAutoFocus={(e) => {
					if (selectedEditCommentRef.current) {
						onCloseAutoFocus?.();
						selectedEditCommentRef.current = false;
					}

					return e.preventDefault();
				}}
			>
				<DropdownMenuGroup>
					<DropdownMenuItem onClick={onEditComment}>
						<PencilIcon className="size-4" />
						Edit comment
					</DropdownMenuItem>
					<DropdownMenuItem onClick={onDeleteComment}>
						<TrashIcon className="size-4" />
						Delete comment
					</DropdownMenuItem>
				</DropdownMenuGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
