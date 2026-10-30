import { Mail01Icon, Message01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Markdown } from "@ryu/blocks/desktop/agent-elements/markdown.tsx";
import { Bubble, BubbleContent } from "@ryu/ui/components/bubble.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { useEffect, useMemo, useState } from "react";
import type { Message as ChatMessage } from "@/types/chat.ts";

const MAX_PREVIEW_MESSAGES = 8;
const MAX_PREVIEW_MESSAGE_LENGTH = 1600;

interface QuickPreviewProps {
	conversationId: string;
	isUnread: boolean;
	loadMessages: (id: string) => Promise<ChatMessage[]>;
	onMarkRead?: (id: string) => void;
	onMarkUnread?: (id: string) => void;
	onOpenChange: (open: boolean) => void;
	open: boolean;
	title: string;
}

function PreviewMessage({ message }: { message: ChatMessage }) {
	const text = message.content.trim();
	if (!text) {
		return null;
	}
	const content =
		text.length > MAX_PREVIEW_MESSAGE_LENGTH
			? `${text.slice(0, MAX_PREVIEW_MESSAGE_LENGTH)}…`
			: text;
	const isUser = message.role === "user";

	return (
		<div
			className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"}`}
			data-testid={`quick-preview-message-${message.id}`}
		>
			<span className="px-2 text-muted-foreground/70 text-xs">
				{isUser ? "You" : "Assistant"}
			</span>
			<Bubble
				align={isUser ? "end" : "start"}
				className="max-w-[92%]"
				variant={isUser ? "default" : "muted"}
			>
				<BubbleContent>
					<Markdown
						className="[&_p]:my-0 [&_p]:leading-relaxed"
						content={content}
					/>
				</BubbleContent>
			</Bubble>
		</div>
	);
}

/**
 * Telegram-style long-press transcript preview. It is intentionally mounted
 * outside the chat route: opening it never selects the conversation and never
 * clears its unread flag. The only state-changing control is the explicit
 * read/unread action in the footer.
 */
export function QuickPreview({
	conversationId,
	isUnread,
	loadMessages,
	onMarkRead,
	onMarkUnread,
	onOpenChange,
	open,
	title,
}: QuickPreviewProps) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		if (!open) {
			return;
		}
		let cancelled = false;
		setLoading(true);
		setFailed(false);
		loadMessages(conversationId)
			.then((nextMessages) => {
				if (!cancelled) {
					setMessages(nextMessages);
				}
			})
			.catch(() => {
				if (!cancelled) {
					setMessages([]);
					setFailed(true);
				}
			})
			.finally(() => {
				if (!cancelled) {
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [conversationId, loadMessages, open]);

	const visibleMessages = useMemo(
		() =>
			messages
				.filter((message) => message.content.trim())
				.slice(-MAX_PREVIEW_MESSAGES),
		[messages]
	);
	const markLabel = isUnread ? "Mark as read" : "Mark as unread";
	const mark = isUnread ? onMarkRead : onMarkUnread;

	return (
		<Dialog onOpenChange={onOpenChange} open={open}>
			<DialogContent
				appearance="quick-preview"
				aria-describedby="quick-preview-description"
				data-testid="quick-preview"
			>
				<DialogHeader purpose="quick-preview">
					<DialogTitle
						className="min-w-0"
						layout="inline"
						typography="compact-preview"
					>
						<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
							<HugeiconsIcon icon={Message01Icon} size={16} />
						</span>
						<span className="truncate">{title}</span>
					</DialogTitle>
					<DialogDescription id="quick-preview-description">
						Quick preview · this chat stays in its current read state.
					</DialogDescription>
				</DialogHeader>

				<div className="max-h-[min(32rem,60dvh)] min-h-32 overflow-y-auto rounded-2xl border border-border bg-background/45 p-3">
					{loading ? (
						<SkeletonRows label="Loading messages…" spacing="comfortable" />
					) : failed ? (
						<p className="flex min-h-24 items-center justify-center text-muted-foreground text-xs">
							Couldn’t load this preview.
						</p>
					) : visibleMessages.length === 0 ? (
						<p className="flex min-h-24 items-center justify-center text-muted-foreground text-xs">
							No messages yet.
						</p>
					) : (
						<div className="flex flex-col gap-3">
							{visibleMessages.map((message) => (
								<PreviewMessage key={message.id} message={message} />
							))}
						</div>
					)}
				</div>

				<DialogFooter className="flex-row items-center justify-between sm:justify-between">
					<p className="min-w-0 text-muted-foreground text-xs">
						Preview only · opening this did not select the chat.
					</p>
					{mark ? (
						<Button
							className="shrink-0"
							onClick={() => mark(conversationId)}
							size="sm"
							variant="outline"
						>
							<HugeiconsIcon icon={Mail01Icon} size={14} />
							{markLabel}
						</Button>
					) : null}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
