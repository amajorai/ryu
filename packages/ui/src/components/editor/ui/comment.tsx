"use client";

import { getCommentKey, getDraftCommentKey } from "@platejs/comment";
import { CommentPlugin, useCommentId } from "@platejs/comment/react";
import { useLiteralMessages, useOptionalI18n } from "@ryu/i18n/react";
import {
	discussionPlugin,
	type TDiscussion,
} from "@ryu/ui/components/editor/plugins/discussion-kit.tsx";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/editor/ui/avatar.tsx";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ArrowUpIcon, CheckIcon, XIcon } from "lucide-react";
import {
	KEYS,
	NodeApi,
	type NodeEntry,
	nanoid,
	type TCommentText,
	type Value,
} from "platejs";
import {
	Plate,
	useEditorPlugin,
	useEditorRef,
	usePluginOption,
} from "platejs/react";
import {
	type Dispatch,
	type MouseEvent,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { CommentMoreDropdown } from "./comment-more-dropdown.tsx";
import {
	formatCommentDate,
	saveDiscussions,
	type TComment,
	useCommentEditor,
} from "./comment-shared.ts";
import { Editor, EditorContainer } from "./editor.tsx";

// biome-ignore lint/performance/noBarrelFile: keeps the comment module's public names stable after the split.
export { formatCommentDate, type TComment } from "./comment-shared.ts";

export function Comment(props: {
	comment: TComment;
	discussionLength: number;
	editingId: string | null;
	index: number;
	setEditingId: Dispatch<SetStateAction<string | null>>;
	documentContent?: string;
	showDocumentContent?: boolean;
	onEditorClick?: () => void;
}) {
	const {
		comment,
		discussionLength,
		documentContent,
		editingId,
		index,
		setEditingId,
		showDocumentContent = false,
		onEditorClick,
	} = props;

	const editor = useEditorRef();
	const locale = useOptionalI18n()?.locale ?? "en";
	const userInfo = usePluginOption(discussionPlugin, "user", comment.userId);
	const currentUserId = usePluginOption(discussionPlugin, "currentUserId");

	const resolveDiscussion = async (id: string) => {
		const updatedDiscussions = editor
			.getOption(discussionPlugin, "discussions")
			.map((discussion) => {
				if (discussion.id === id) {
					return { ...discussion, isResolved: true };
				}
				return discussion;
			});
		saveDiscussions(editor, updatedDiscussions);
	};

	const removeDiscussion = async (id: string) => {
		const updatedDiscussions = editor
			.getOption(discussionPlugin, "discussions")
			.filter((discussion) => discussion.id !== id);
		saveDiscussions(editor, updatedDiscussions);
	};

	const updateComment = async (input: {
		id: string;
		contentRich: Value;
		discussionId: string;
		isEdited: boolean;
	}) => {
		const updatedDiscussions = editor
			.getOption(discussionPlugin, "discussions")
			.map((discussion) => {
				if (discussion.id === input.discussionId) {
					const updatedComments = discussion.comments.map((comment) => {
						if (comment.id === input.id) {
							return {
								...comment,
								contentRich: input.contentRich,
								isEdited: true,
								updatedAt: new Date(),
							};
						}
						return comment;
					});
					return { ...discussion, comments: updatedComments };
				}
				return discussion;
			});
		saveDiscussions(editor, updatedDiscussions);
	};

	const { tf } = useEditorPlugin(CommentPlugin);

	// Replace to your own backend or refer to potion
	const isMyComment = currentUserId === comment.userId;

	const initialValue = comment.contentRich;

	const commentEditor = useCommentEditor(
		{
			id: comment.id,
			value: initialValue,
		},
		[initialValue]
	);

	const onCancel = () => {
		setEditingId(null);
		commentEditor.tf.replaceNodes(initialValue, {
			at: [],
			children: true,
		});
	};

	const onSave = () => {
		Promise.resolve(
			updateComment({
				id: comment.id,
				contentRich: commentEditor.children,
				discussionId: comment.discussionId,
				isEdited: true,
			})
		).catch(() => undefined);
		setEditingId(null);
	};

	const onResolveComment = () => {
		resolveDiscussion(comment.discussionId).catch(() => undefined);
		tf.comment.unsetMark({ id: comment.discussionId });
	};

	const isFirst = index === 0;
	const isLast = index === discussionLength - 1;
	const isEditing = editingId && editingId === comment.id;

	const [hovering, setHovering] = useState(false);
	const [dropdownOpen, setDropdownOpen] = useState(false);

	return (
		<div
			onMouseEnter={() => setHovering(true)}
			onMouseLeave={() => setHovering(false)}
		>
			<div className="relative flex items-center">
				<Avatar className="size-5">
					<AvatarImage alt={userInfo?.name} src={userInfo?.avatarUrl} />
					<AvatarFallback>{userInfo?.name?.[0]}</AvatarFallback>
				</Avatar>
				<h4 className="mx-2 font-medium text-sm leading-none">
					{/* Replace to your own backend or refer to potion */}
					{userInfo?.name}
				</h4>

				<div className="text-muted-foreground/80 text-xs leading-none">
					<span className="me-1">
						{formatCommentDate(new Date(comment.createdAt), locale)}
					</span>
					{comment.isEdited && <span>(edited)</span>}
				</div>

				{isMyComment && (hovering || dropdownOpen) && (
					<div className="absolute end-0 top-0 flex space-x-1 rtl:space-x-reverse">
						{index === 0 && (
							<Button
								className="h-6 p-1 text-muted-foreground"
								onClick={onResolveComment}
								type="button"
								variant="ghost"
							>
								<CheckIcon className="size-4" />
							</Button>
						)}

						<CommentMoreDropdown
							comment={comment}
							dropdownOpen={dropdownOpen}
							onCloseAutoFocus={() => {
								setTimeout(() => {
									commentEditor.tf.focus({ edge: "endEditor" });
								}, 0);
							}}
							onRemoveComment={() => {
								if (discussionLength === 1) {
									tf.comment.unsetMark({ id: comment.discussionId });
									removeDiscussion(comment.discussionId).catch(() => undefined);
								}
							}}
							setDropdownOpen={setDropdownOpen}
							setEditingId={setEditingId}
						/>
					</div>
				)}
			</div>

			{isFirst && showDocumentContent && (
				<div className="relative mt-1 flex ps-[32px] text-muted-foreground text-sm">
					{discussionLength > 1 && (
						<div className="absolute start-3 top-[5px] h-full w-0.5 shrink-0 bg-muted" />
					)}
					<div className="ryu-editor-comment-accent my-px w-0.5 shrink-0" />
					{documentContent && <div className="ms-2">{documentContent}</div>}
				</div>
			)}

			<div className="relative my-1 ps-[26px]">
				{!isLast && (
					<div className="absolute start-3 top-0 h-full w-0.5 shrink-0 bg-muted" />
				)}
				<Plate editor={commentEditor} readOnly={!isEditing}>
					<EditorContainer variant="comment">
						<Editor
							className="w-auto grow"
							onClick={() => onEditorClick?.()}
							variant="comment"
						/>

						{isEditing && (
							<div className="ms-auto flex shrink-0 gap-1">
								<Button
									aria-label="Cancel"
									className="size-[28px]"
									onClick={(e: MouseEvent<HTMLButtonElement>) => {
										e.stopPropagation();
										onCancel();
									}}
									size="icon"
									variant="ghost"
								>
									<div className="flex size-5 shrink-0 items-center justify-center rounded-[50%] bg-primary/40">
										<XIcon className="size-3 stroke-[3px] text-background" />
									</div>
								</Button>

								<Button
									aria-label="Save"
									onClick={(e: MouseEvent<HTMLButtonElement>) => {
										e.stopPropagation();
										onSave();
									}}
									size="icon"
									variant="ghost"
								>
									<div className="flex size-5 shrink-0 items-center justify-center rounded-[50%] bg-primary">
										<CheckIcon className="size-3 stroke-[3px] text-background" />
									</div>
								</Button>
							</div>
						)}
					</EditorContainer>
				</Plate>
			</div>
		</div>
	);
}

export function CommentCreateForm({
	autoFocus = false,
	className,
	discussionId: discussionIdProp,
	focusOnMount = false,
}: {
	autoFocus?: boolean;
	className?: string;
	discussionId?: string;
	focusOnMount?: boolean;
}) {
	const discussions = usePluginOption(discussionPlugin, "discussions");
	const tl = useLiteralMessages();

	const editor = useEditorRef();
	const commentId = useCommentId();
	const discussionId = discussionIdProp ?? commentId;

	const userInfo = usePluginOption(discussionPlugin, "currentUser");
	const [commentValue, setCommentValue] = useState<Value | undefined>();
	const commentContent = useMemo(
		() =>
			commentValue
				? NodeApi.string({ children: commentValue, type: KEYS.p })
				: "",
		[commentValue]
	);
	const commentEditor = useCommentEditor();

	useEffect(() => {
		if (commentEditor && focusOnMount) {
			commentEditor.tf.focus();
		}
	}, [commentEditor, focusOnMount]);

	const onAddComment = useCallback(async () => {
		if (!commentValue) {
			return;
		}

		commentEditor.tf.reset();

		if (discussionId) {
			// Get existing discussion
			const discussion = discussions.find((d) => d.id === discussionId);
			if (!discussion) {
				// Mock creating suggestion
				const newDiscussion: TDiscussion = {
					id: discussionId,
					comments: [
						{
							id: nanoid(),
							contentRich: commentValue,
							createdAt: new Date(),
							discussionId,
							isEdited: false,
							userId: editor.getOption(discussionPlugin, "currentUserId"),
						},
					],
					createdAt: new Date(),
					isResolved: false,
					userId: editor.getOption(discussionPlugin, "currentUserId"),
				};

				saveDiscussions(editor, [...discussions, newDiscussion]);
				return;
			}

			// Create reply comment
			const comment: TComment = {
				id: nanoid(),
				contentRich: commentValue,
				createdAt: new Date(),
				discussionId,
				isEdited: false,
				userId: editor.getOption(discussionPlugin, "currentUserId"),
			};

			// Add reply to discussion comments
			const updatedDiscussion = {
				...discussion,
				comments: [...discussion.comments, comment],
			};

			// Filter out old discussion and add updated one
			const updatedDiscussions = discussions
				.filter((d) => d.id !== discussionId)
				.concat(updatedDiscussion);

			saveDiscussions(editor, updatedDiscussions);

			return;
		}

		const commentsNodeEntry = editor
			.getApi(CommentPlugin)
			.comment.nodes({ at: [], isDraft: true });

		if (commentsNodeEntry.length === 0) {
			return;
		}

		const documentContent = commentsNodeEntry
			.map(([node, _path]: NodeEntry<TCommentText>) => node.text)
			.join("");

		const _discussionId = nanoid();
		// Mock creating new discussion
		const newDiscussion: TDiscussion = {
			id: _discussionId,
			comments: [
				{
					id: nanoid(),
					contentRich: commentValue,
					createdAt: new Date(),
					discussionId: _discussionId,
					isEdited: false,
					userId: editor.getOption(discussionPlugin, "currentUserId"),
				},
			],
			createdAt: new Date(),
			documentContent,
			isResolved: false,
			userId: editor.getOption(discussionPlugin, "currentUserId"),
		};

		saveDiscussions(editor, [...discussions, newDiscussion]);

		const id = newDiscussion.id;

		commentsNodeEntry.forEach(([, path]: NodeEntry<TCommentText>) => {
			editor.tf.setNodes(
				{
					[getCommentKey(id)]: true,
				},
				{ at: path, split: true }
			);
			editor.tf.unsetNodes([getDraftCommentKey()], { at: path });
		});
	}, [commentValue, commentEditor.tf, discussionId, editor, discussions]);

	return (
		<div className={cn("flex w-full", className)}>
			<div className="me-1 mt-2 shrink-0">
				{/* Replace to your own backend or refer to potion */}
				<Avatar className="size-5">
					<AvatarImage alt={userInfo?.name} src={userInfo?.avatarUrl} />
					<AvatarFallback>{userInfo?.name?.[0]}</AvatarFallback>
				</Avatar>
			</div>

			<div className="relative flex grow gap-2">
				<Plate
					editor={commentEditor}
					onChange={({ value }) => {
						setCommentValue(value);
					}}
				>
					<EditorContainer variant="comment">
						<Editor
							autoComplete="off"
							autoFocus={autoFocus}
							className="min-h-[25px] grow pe-8 pt-0.5"
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									onAddComment();
								}
							}}
							placeholder={tl("Reply…")}
							variant="comment"
						/>

						<Button
							aria-label="Add comment"
							className="absolute end-0.5 bottom-0.5 ms-auto size-6 shrink-0"
							disabled={commentContent.trim().length === 0}
							onClick={(e) => {
								e.stopPropagation();
								onAddComment();
							}}
							size="icon"
							variant="ghost"
						>
							<div className="flex size-6 items-center justify-center rounded-full">
								<ArrowUpIcon />
							</div>
						</Button>
					</EditorContainer>
				</Plate>
			</div>
		</div>
	);
}
