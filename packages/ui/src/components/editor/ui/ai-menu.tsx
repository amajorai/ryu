"use client";

import {
	AIChatPlugin,
	AIPlugin,
	useEditorChat,
	useLastAssistantMessage,
} from "@platejs/ai/react";
import { getTransientCommentKey } from "@platejs/comment";
import { BlockSelectionPlugin, useIsSelecting } from "@platejs/selection/react";
import { getTransientSuggestionKey } from "@platejs/suggestion";
import { commentPlugin } from "@ryu/ui/components/editor/plugins/comment-kit.tsx";
import { Button } from "@ryu/ui/components/editor/ui/button.tsx";
import {
	Command,
	CommandGroup,
	CommandItem,
	CommandList,
} from "@ryu/ui/components/editor/ui/command.tsx";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@ryu/ui/components/editor/ui/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { Command as CommandPrimitive } from "cmdk";
import {
	Album,
	BadgeHelp,
	BookOpenCheck,
	Check,
	CornerUpLeft,
	FeatherIcon,
	ListEnd,
	ListMinus,
	ListPlus,
	Loader2Icon,
	PauseIcon,
	PenLine,
	SmileIcon,
	TriangleAlertIcon,
	Wand,
	X,
} from "lucide-react";
import {
	isHotkey,
	KEYS,
	NodeApi,
	type NodeEntry,
	type SlateEditor,
	TextApi,
} from "platejs";
import {
	type PlateEditor,
	useEditorPlugin,
	useEditorRef,
	useFocusedLast,
	useHotkeys,
	usePluginOption,
} from "platejs/react";
import {
	type ComponentType,
	type ReactNode,
	useEffect,
	useMemo,
	useState,
} from "react";

import { AIChatEditor } from "./ai-chat-editor.tsx";

/**
 * The editor AI fails closed: when it is unconfigured or the Gateway call fails,
 * the real error is shown instead of any generated-looking text. Never swallow
 * this — a silent no-op reads as "the AI decided to say nothing".
 */
const toErrorText = (error: Error | undefined): string =>
	error?.message?.trim() ||
	"The AI request failed. Check Settings → Editor and your Gateway.";

export function AIMenu() {
	const { api, editor } = useEditorPlugin(AIChatPlugin);
	const mode = usePluginOption(AIChatPlugin, "mode");
	const toolName = usePluginOption(AIChatPlugin, "toolName");

	const streaming = usePluginOption(AIChatPlugin, "streaming");
	const isSelecting = useIsSelecting();
	const isFocusedLast = useFocusedLast();
	const open = usePluginOption(AIChatPlugin, "open") && isFocusedLast;
	const [value, setValue] = useState("");

	const [input, setInput] = useState("");

	const chat = usePluginOption(AIChatPlugin, "chat");

	const { clearError, error, messages, status } = chat;
	const [anchorElement, setAnchorElement] = useState<HTMLElement | null>(null);

	const content = useLastAssistantMessage()?.parts.find(
		(part) => part.type === "text"
	)?.text;

	useEffect(() => {
		if (!streaming) {
			return;
		}

		const anchorEntry = api.aiChat.node({ anchor: true });
		if (!anchorEntry) {
			return;
		}

		const anchorDom = editor.api.toDOMNode(anchorEntry[0])!;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- Position the popover from editor DOM while the edit stream is active.
		setAnchorElement(anchorDom);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [streaming, api.aiChat.node, editor.api.toDOMNode]);

	const setOpen = (open: boolean) => {
		if (open) {
			api.aiChat.show();
		} else {
			api.aiChat.hide();
		}
	};

	const show = (anchorElement: HTMLElement) => {
		setAnchorElement(anchorElement);
		setOpen(true);
	};

	useEditorChat({
		onOpenBlockSelection: (blocks: NodeEntry[]) => {
			show(editor.api.toDOMNode(blocks.at(-1)?.[0])!);
		},
		onOpenChange: (open) => {
			if (!open) {
				setAnchorElement(null);
				setInput("");
				// Closing the menu acknowledges any surfaced failure, so the
				// AILoadingBar fallback banner does not re-raise it. Optional call:
				// AIChatPlugin seeds the option with a `{ messages: [] }` placeholder
				// that carries no helpers, so `clearError` is absent until useChat's
				// effect registers the real chat.
				clearError?.();
			}
		},
		onOpenCursor: () => {
			const [ancestor] = editor.api.block({ highest: true })!;

			if (!(editor.api.isAt({ end: true }) || editor.api.isEmpty(ancestor))) {
				editor
					.getApi(BlockSelectionPlugin)
					.blockSelection.set(ancestor.id as string);
			}

			show(editor.api.toDOMNode(ancestor)!);
		},
		onOpenSelection: () => {
			show(editor.api.toDOMNode(editor.api.blocks().at(-1)?.[0])!);
		},
	});

	useHotkeys("esc", () => {
		api.aiChat.stop();
	});

	const isLoading = status === "streaming" || status === "submitted";
	const errorMessage = status === "error" ? toErrorText(error) : null;

	useEffect(() => {
		if (toolName !== "edit" || mode !== "chat" || isLoading) {
			return;
		}

		let anchorNode = editor.api.node({
			at: [],
			reverse: true,
			match: (n) => !!n[KEYS.suggestion] && !!n[getTransientSuggestionKey()],
		});

		if (!anchorNode) {
			anchorNode = editor
				.getApi(BlockSelectionPlugin)
				.blockSelection.getNodes({ selectionFallback: true, sort: true })
				.at(-1);
		}

		if (!anchorNode) {
			return;
		}

		const block = editor.api.block({ at: anchorNode[1] });
		// eslint-disable-next-line react-hooks/set-state-in-effect -- Position the popover from editor DOM after the edit stream completes.
		setAnchorElement(editor.api.toDOMNode(block?.[0]!)!);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [
		isLoading,
		editor.api.toDOMNode,
		toolName,
		mode,
		editor.api.node,
		editor.api.block,
		editor.getApi,
	]);

	if (isLoading && mode === "insert") {
		return null;
	}

	if (toolName === "comment") {
		return null;
	}

	if (toolName === "edit" && mode === "chat" && isLoading) {
		return null;
	}

	return (
		<Popover modal={false} onOpenChange={setOpen} open={open}>
			<PopoverAnchor virtualRef={{ current: anchorElement! }} />

			<PopoverContent
				align="center"
				className="border-none bg-transparent p-0 shadow-none"
				onEscapeKeyDown={(e) => {
					e.preventDefault();

					api.aiChat.hide();
				}}
				side="bottom"
				style={{
					width: anchorElement?.offsetWidth,
				}}
			>
				<Command
					className="w-full rounded-lg border shadow-md"
					onValueChange={setValue}
					value={value}
				>
					{mode === "chat" &&
						isSelecting &&
						content &&
						toolName === "generate" && <AIChatEditor content={content} />}

					{errorMessage && (
						<div
							className="flex select-none items-start gap-2 border-b bg-destructive/10 p-2 text-destructive text-sm"
							role="alert"
						>
							<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
							<span className="min-w-0 break-words">{errorMessage}</span>
						</div>
					)}

					{isLoading ? (
						<div className="flex grow select-none items-center gap-2 p-2 text-muted-foreground text-sm">
							<Loader2Icon className="size-4 animate-spin" />
							{messages.length > 1 ? "Editing..." : "Thinking..."}
						</div>
					) : (
						<CommandPrimitive.Input
							autoFocus
							className={cn(
								"flex h-9 w-full min-w-0 border-input bg-transparent px-3 py-1 text-base outline-none transition-[color,box-shadow] placeholder:text-muted-foreground md:text-sm dark:bg-input/30",
								"aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
								"border-b focus-visible:ring-transparent"
							)}
							data-plate-focus
							onKeyDown={(e) => {
								if (isHotkey("backspace")(e) && input.length === 0) {
									e.preventDefault();
									api.aiChat.hide();
								}
								if (isHotkey("enter")(e) && !e.shiftKey && !value) {
									e.preventDefault();
									api.aiChat.submit(input).catch(() => undefined);
									setInput("");
								}
							}}
							onValueChange={setInput}
							placeholder="Ask AI anything..."
							value={input}
						/>
					)}

					{!isLoading && (
						<CommandList>
							<AIMenuItems
								input={input}
								setInput={setInput}
								setValue={setValue}
							/>
						</CommandList>
					)}
				</Command>
			</PopoverContent>
		</Popover>
	);
}

type EditorChatState =
	| "cursorCommand"
	| "cursorSuggestion"
	| "selectionCommand"
	| "selectionSuggestion";

// NOTE: the "Comment" item (toolName: "comment") and the multi-cell table edit
// path used to exist here. Both only ever worked because the chat transport
// fabricated `data-comment` / `data-table` stream parts from a mock generator —
// the real Gateway path streams text and cannot emit them. They are gated off
// rather than shipped as fake affordances; re-adding them needs real structured
// output (streamObject) support decided at the product level.
const aiChatItems = {
	accept: {
		icon: <Check />,
		label: "Accept",
		value: "accept",
		onSelect: ({ aiEditor, editor }) => {
			const { mode, toolName } = editor.getOptions(AIChatPlugin);

			if (mode === "chat" && toolName === "generate") {
				return editor
					.getTransforms(AIChatPlugin)
					.aiChat.replaceSelection(aiEditor);
			}

			editor.getTransforms(AIChatPlugin).aiChat.accept();
			editor.tf.focus({ edge: "end" });
		},
	},
	continueWrite: {
		icon: <PenLine />,
		label: "Continue writing",
		value: "continueWrite",
		onSelect: ({ editor, input }) => {
			const ancestorNode = editor.api.block({ highest: true });

			if (!ancestorNode) {
				return;
			}

			const isEmpty = NodeApi.string(ancestorNode[0]).trim().length === 0;

			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					mode: "insert",
					prompt: isEmpty
						? `<Document>
{editor}
</Document>
Start writing a new paragraph AFTER <Document> ONLY ONE SENTENCE`
						: "Continue writing AFTER <Block> ONLY ONE SENTENCE. DONT REPEAT THE TEXT.",
					toolName: "generate",
				})
			).catch(() => undefined);
		},
	},
	discard: {
		icon: <X />,
		label: "Discard",
		shortcut: "Escape",
		value: "discard",
		onSelect: ({ editor }) => {
			editor.getTransforms(AIPlugin).ai.undo();
			editor.getApi(AIChatPlugin).aiChat.hide();
		},
	},
	emojify: {
		icon: <SmileIcon />,
		label: "Emojify",
		value: "emojify",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt:
						"Add a small number of contextually relevant emojis within each block only. You may insert emojis, but do not remove, replace, or rewrite existing text, and do not modify Markdown syntax, links, or line breaks.",
					toolName: "edit",
				})
			).catch(() => undefined);
		},
	},
	explain: {
		icon: <BadgeHelp />,
		label: "Explain",
		value: "explain",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt: {
						default: "Explain {editor}",
						selecting: "Explain",
					},
					toolName: "generate",
				})
			).catch(() => undefined);
		},
	},
	fixSpelling: {
		icon: <Check />,
		label: "Fix spelling & grammar",
		value: "fixSpelling",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt:
						"Fix spelling, grammar, and punctuation errors within each block only, without changing meaning, tone, or adding new information.",
					toolName: "edit",
				})
			).catch(() => undefined);
		},
	},
	generateMarkdownSample: {
		icon: <BookOpenCheck />,
		label: "Generate Markdown sample",
		value: "generateMarkdownSample",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt: "Generate a markdown sample",
					toolName: "generate",
				})
			).catch(() => undefined);
		},
	},
	generateMdxSample: {
		icon: <BookOpenCheck />,
		label: "Generate MDX sample",
		value: "generateMdxSample",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt: "Generate a mdx sample",
					toolName: "generate",
				})
			).catch(() => undefined);
		},
	},
	improveWriting: {
		icon: <Wand />,
		label: "Improve writing",
		value: "improveWriting",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt:
						"Improve the writing for clarity and flow, without changing meaning or adding new information.",
					toolName: "edit",
				})
			).catch(() => undefined);
		},
	},
	insertBelow: {
		icon: <ListEnd />,
		label: "Insert below",
		value: "insertBelow",
		onSelect: ({ aiEditor, editor }) => {
			/** Format: 'none' Fix insert table */
			Promise.resolve(
				editor
					.getTransforms(AIChatPlugin)
					.aiChat.insertBelow(aiEditor, { format: "none" })
			).catch(() => undefined);
		},
	},
	makeLonger: {
		icon: <ListPlus />,
		label: "Make longer",
		value: "makeLonger",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt:
						"Make the content longer by elaborating on existing ideas within each block only, without changing meaning or adding new information.",
					toolName: "edit",
				})
			).catch(() => undefined);
		},
	},
	makeShorter: {
		icon: <ListMinus />,
		label: "Make shorter",
		value: "makeShorter",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt:
						"Make the content shorter by reducing verbosity within each block only, without changing meaning or removing essential information.",
					toolName: "edit",
				})
			).catch(() => undefined);
		},
	},
	replace: {
		icon: <Check />,
		label: "Replace selection",
		value: "replace",
		onSelect: ({ aiEditor, editor }) => {
			editor
				.getTransforms(AIChatPlugin)
				.aiChat.replaceSelection(aiEditor)
				.catch(() => undefined);
		},
	},
	simplifyLanguage: {
		icon: <FeatherIcon />,
		label: "Simplify language",
		value: "simplifyLanguage",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					prompt:
						"Simplify the language by using clearer and more straightforward wording within each block only, without changing meaning or adding new information.",
					toolName: "edit",
				})
			).catch(() => undefined);
		},
	},
	summarize: {
		icon: <Album />,
		label: "Add a summary",
		value: "summarize",
		onSelect: ({ editor, input }) => {
			Promise.resolve(
				editor.getApi(AIChatPlugin).aiChat.submit(input, {
					mode: "insert",
					prompt: {
						default: "Summarize {editor}",
						selecting: "Summarize",
					},
					toolName: "generate",
				})
			).catch(() => undefined);
		},
	},
	tryAgain: {
		icon: <CornerUpLeft />,
		label: "Try again",
		value: "tryAgain",
		onSelect: ({ editor }) => {
			editor
				.getApi(AIChatPlugin)
				.aiChat.reload()
				.catch(() => undefined);
		},
	},
} satisfies Record<
	string,
	{
		icon: ReactNode;
		label: string;
		value: string;
		component?: ComponentType<{ menuState: EditorChatState }>;
		filterItems?: boolean;
		items?: { label: string; value: string }[];
		shortcut?: string;
		onSelect?: ({
			aiEditor,
			editor,
			input,
		}: {
			aiEditor: SlateEditor;
			editor: PlateEditor;
			input: string;
		}) => void;
	}
>;

const menuStateItems: Record<
	EditorChatState,
	{
		items: (typeof aiChatItems)[keyof typeof aiChatItems][];
		heading?: string;
	}[]
> = {
	cursorCommand: [
		{
			items: [
				aiChatItems.generateMdxSample,
				aiChatItems.generateMarkdownSample,
				aiChatItems.continueWrite,
				aiChatItems.summarize,
				aiChatItems.explain,
			],
		},
	],
	cursorSuggestion: [
		{
			items: [aiChatItems.accept, aiChatItems.discard, aiChatItems.tryAgain],
		},
	],
	selectionCommand: [
		{
			items: [
				aiChatItems.improveWriting,
				aiChatItems.emojify,
				aiChatItems.makeLonger,
				aiChatItems.makeShorter,
				aiChatItems.fixSpelling,
				aiChatItems.simplifyLanguage,
			],
		},
	],
	selectionSuggestion: [
		{
			items: [
				aiChatItems.accept,
				aiChatItems.discard,
				aiChatItems.insertBelow,
				aiChatItems.tryAgain,
			],
		},
	],
};

export const AIMenuItems = ({
	input,
	setInput,
	setValue,
}: {
	input: string;
	setInput: (value: string) => void;
	setValue: (value: string) => void;
}) => {
	const editor = useEditorRef();
	const { messages } = usePluginOption(AIChatPlugin, "chat");
	const aiEditor = usePluginOption(AIChatPlugin, "aiEditor")!;
	const isSelecting = useIsSelecting();

	const menuState = useMemo(() => {
		if (messages && messages.length > 0) {
			return isSelecting ? "selectionSuggestion" : "cursorSuggestion";
		}

		return isSelecting ? "selectionCommand" : "cursorCommand";
	}, [isSelecting, messages]);

	const menuGroups = useMemo(() => {
		const items = menuStateItems[menuState];

		return items;
	}, [menuState]);

	useEffect(() => {
		if (menuGroups.length > 0 && menuGroups[0].items.length > 0) {
			setValue(menuGroups[0].items[0].value);
		}
	}, [menuGroups, setValue]);

	return (
		<>
			{menuGroups.map((group, index) => (
				<CommandGroup heading={group.heading} key={index}>
					{group.items.map((menuItem) => (
						<CommandItem
							className="[&_svg]:text-muted-foreground"
							key={menuItem.value}
							onSelect={() => {
								menuItem.onSelect?.({
									aiEditor,
									editor,
									input,
								});
								setInput("");
							}}
							value={menuItem.value}
						>
							{menuItem.icon}
							<span>{menuItem.label}</span>
						</CommandItem>
					))}
				</CommandGroup>
			))}
		</>
	);
};

export function AILoadingBar() {
	const editor = useEditorRef();

	const toolName = usePluginOption(AIChatPlugin, "toolName");
	const chat = usePluginOption(AIChatPlugin, "chat");
	const mode = usePluginOption(AIChatPlugin, "mode");
	// Mirrors AIMenu's `open` exactly (same plugin option AND useFocusedLast) so
	// the two error surfaces are exact complements: in every state exactly one of
	// them renders — never both, and never neither.
	const isFocusedLast = useFocusedLast();
	const open = usePluginOption(AIChatPlugin, "open") && isFocusedLast;

	const { clearError, error, status } = chat;

	const { api } = useEditorPlugin(AIChatPlugin);

	const isLoading = status === "streaming" || status === "submitted";

	const handleComments = (type: "accept" | "reject") => {
		if (type === "accept") {
			editor.tf.unsetNodes([getTransientCommentKey()], {
				at: [],
				match: (n) => TextApi.isText(n) && !!n[KEYS.comment],
			});
		}

		if (type === "reject") {
			editor
				.getTransforms(commentPlugin)
				.comment.unsetMark({ transient: true });
		}

		api.aiChat.hide();
	};

	useHotkeys("esc", () => {
		api.aiChat.stop();
	});

	// Fallback error surface: the AIMenu popover renders the error inline, but it
	// only mounts while the menu is open. When it is closed (e.g. an insert-mode
	// run that failed after the editor lost focus) the failure would otherwise be
	// invisible — and an invisible failure is indistinguishable from a fabricated
	// empty answer. Never let a failed AI call pass silently.
	if (status === "error" && !open) {
		return (
			<div
				className="absolute bottom-4 left-1/2 z-50 flex max-w-md -translate-x-1/2 items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm shadow-md"
				role="alert"
			>
				<TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
				<span className="min-w-0 break-words">{toErrorText(error)}</span>
				<Button
					className="text-xs"
					onClick={() => clearError()}
					size="sm"
					variant="ghost"
				>
					Dismiss
				</Button>
			</div>
		);
	}

	if (
		isLoading &&
		(mode === "insert" ||
			toolName === "comment" ||
			(toolName === "edit" && mode === "chat"))
	) {
		return (
			<div
				className={cn(
					"absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-muted px-3 py-1.5 text-muted-foreground text-sm shadow-md transition-all duration-300"
				)}
			>
				<span className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
				<span>{status === "submitted" ? "Thinking..." : "Writing..."}</span>
				<Button
					className="flex items-center gap-1 text-xs"
					onClick={() => api.aiChat.stop()}
					size="sm"
					variant="ghost"
				>
					<PauseIcon className="h-4 w-4" />
					Stop
					<kbd className="ml-1 rounded bg-border px-1 font-mono text-[10px] text-muted-foreground shadow-sm">
						Esc
					</kbd>
				</Button>
			</div>
		);
	}

	if (toolName === "comment" && status === "ready") {
		return (
			<div
				className={cn(
					"absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-0 rounded-xl border border-border/50 bg-popover p-1 text-muted-foreground text-sm shadow-xl backdrop-blur-sm",
					"p-3"
				)}
			>
				{/* Header with controls */}
				<div className="flex w-full items-center justify-between gap-3">
					<div className="flex items-center gap-5">
						<Button
							disabled={isLoading}
							onClick={() => handleComments("accept")}
							size="sm"
						>
							Accept
						</Button>

						<Button
							disabled={isLoading}
							onClick={() => handleComments("reject")}
							size="sm"
						>
							Reject
						</Button>
					</div>
				</div>
			</div>
		);
	}

	return null;
}
