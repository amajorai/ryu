import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type {
	InterfaceAgent,
	InterfaceGroup,
	InterfaceThread,
} from "@ryuhq/protocol/interfaces";
import {
	ArrowLeft,
	ChevronLeft,
	ChevronRight,
	Reply,
	Star,
} from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode, Ref } from "react";
import { BoardAvatar } from "./board-avatar.tsx";
import { agentHandle } from "./interface-renderer.ts";
import type { MailStatusChip } from "./mail-model.ts";
import { MailIconButton, MailLabelChip, MailStatusTag } from "./mail-parts.tsx";
import { useReducedMotion } from "./reduced-motion.ts";

export interface MailReaderModel {
	/** Everyone on the thread after the sender, for the "to" line. */
	cc: InterfaceAgent[];
	date: string;
	labels: InterfaceGroup[];
	/** "3 of 10" within the list the user opened it from, when it is there. */
	position: { index: number; total: number } | null;
	sender: InterfaceAgent | null;
	status: MailStatusChip | null;
	subject: string;
	thread: InterfaceThread;
}

function recipientsLine(model: MailReaderModel): string {
	const others = model.cc.map((agent) => agent.name);
	return ["me", ...others].join(", ");
}

/**
 * The reading pane: Gmail's conversation toolbar, subject with its labels,
 * and the sender header, then the host's own conversation surface as the
 * message body. Nothing here sends: replies happen in `threadView`.
 */
export function MailReader({
	backLabel,
	model,
	onBack,
	onNewer,
	onOlder,
	ref,
	threadView,
}: {
	backLabel: string;
	/** Null while the host shows a brand-new conversation. */
	model: MailReaderModel | null;
	onBack: () => void;
	onNewer: (() => void) | null;
	onOlder: (() => void) | null;
	ref?: Ref<HTMLElement>;
	threadView: ReactNode;
}) {
	const tl = useLiteralMessages();
	const reduceMotion = useReducedMotion();
	const subject = model?.subject ?? "New message";
	return (
		<motion.section
			animate={{ opacity: 1 }}
			aria-label={tl("Conversation: {subject}", { subject })}
			className="@container/reader flex min-h-0 min-w-0 flex-1 flex-col bg-background outline-none"
			data-testid="mail-reader"
			initial={reduceMotion ? false : { opacity: 0 }}
			key={model?.thread.id ?? "new"}
			ref={ref}
			tabIndex={-1}
			transition={{ duration: 0.16, ease: "easeOut" }}
		>
			<div
				aria-label="Conversation actions"
				className="flex h-12 shrink-0 items-center gap-1 px-2"
				role="toolbar"
			>
				<MailIconButton label={backLabel} onClick={onBack} shortcut="u">
					<ArrowLeft aria-hidden="true" className="size-4.5" />
				</MailIconButton>
				{model?.position ? (
					<span className="ml-auto flex items-center gap-1">
						<span
							className="px-2 text-muted-foreground text-xs tabular-nums"
							data-testid="mail-reader-position"
						>
							{model.position.index + 1} of {model.position.total}
						</span>
						<MailIconButton
							disabled={!onNewer}
							label="Newer"
							onClick={onNewer ?? undefined}
							shortcut="k"
						>
							<ChevronLeft aria-hidden="true" className="size-4.5" />
						</MailIconButton>
						<MailIconButton
							disabled={!onOlder}
							label="Older"
							onClick={onOlder ?? undefined}
							shortcut="j"
						>
							<ChevronRight aria-hidden="true" className="size-4.5" />
						</MailIconButton>
					</span>
				) : null}
			</div>
			<MailReaderHeading model={model} subject={subject} />
			<div
				className="flex min-h-0 flex-1 flex-col"
				data-testid="mail-thread-view"
			>
				{threadView}
			</div>
		</motion.section>
	);
}

/** Subject with its status and labels, then the sender block. */
function MailReaderHeading({
	model,
	subject,
}: {
	model: MailReaderModel | null;
	subject: string;
}) {
	const sender = model?.sender ?? null;
	return (
		<header className="flex shrink-0 flex-col gap-4 px-6 pt-3 pb-3">
			<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
				<h2
					className="min-w-0 text-pretty font-normal text-[22px] text-foreground leading-7"
					data-testid="mail-reader-subject"
				>
					{subject}
				</h2>
				{model?.status || (model?.labels.length ?? 0) > 0 ? (
					<span className="flex flex-wrap items-center gap-1.5">
						{model?.status ? <MailStatusTag chip={model.status} /> : null}
						{model?.labels.map((label) => (
							<MailLabelChip key={label.id} label={label} />
						))}
					</span>
				) : null}
			</div>
			{model ? (
				<div className="flex min-w-0 items-start gap-3">
					{sender ? (
						<BoardAvatar
							agent={sender}
							className="size-10"
							name={sender.name}
							size={28}
						/>
					) : (
						<span
							aria-hidden="true"
							className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground text-sm"
						>
							me
						</span>
					)}
					<div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
						<p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
							<span className="font-semibold text-foreground">
								{sender?.name ?? "me"}
							</span>
							{sender ? (
								<span className="truncate text-muted-foreground text-xs">
									{`<${agentHandle(sender.name).slice(1)}>`}
								</span>
							) : null}
						</p>
						<p className="truncate text-muted-foreground text-xs">
							to {recipientsLine(model)}
						</p>
					</div>
					<div className="flex shrink-0 items-center gap-3 pt-0.5">
						<time
							className="@min-[560px]/reader:inline hidden text-muted-foreground text-xs"
							dateTime={model.thread.updatedAt}
						>
							{model.date}
						</time>
						<Star
							aria-label={model.thread.pinned ? "Starred" : "Not starred"}
							className={cn(
								"size-4.5",
								model.thread.pinned
									? "fill-warning text-warning"
									: "text-foreground/30"
							)}
							role="img"
							strokeWidth={1.75}
						/>
					</div>
				</div>
			) : null}
		</header>
	);
}

/**
 * The reading pane at rest on a wide window: the list's cursor row previewed
 * like a mail client's reading pane — subject, sender, the latest message in
 * full — with one way into the real conversation. It follows j/k.
 */
export function MailPreview({
	model,
	onOpen,
}: {
	model: MailReaderModel;
	onOpen: () => void;
}) {
	const tl = useLiteralMessages();
	const { thread } = model;
	const message = thread.lastMessage?.trim();
	const fromMe = thread.lastMessageRole === "user";
	return (
		<section
			aria-label={tl("Preview: {subject}", { subject: model.subject })}
			className="@container/reader flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background"
			data-testid="mail-preview"
		>
			<div className="h-12 shrink-0" />
			<MailReaderHeading model={model} subject={model.subject} />
			<div className="flex flex-col gap-6 px-6 pt-2 pb-8">
				{message ? (
					<div className="flex flex-col gap-2">
						{fromMe ? (
							<p className="text-muted-foreground text-xs">You wrote</p>
						) : null}
						<p className="max-w-[68ch] whitespace-pre-line text-[15px] text-foreground leading-7">
							{message}
						</p>
					</div>
				) : (
					<p className="text-muted-foreground text-sm">No messages yet.</p>
				)}
				<div className="flex flex-wrap items-center gap-3 border-border border-t pt-6">
					<Button
						aria-keyshortcuts="o"
						className="rounded-full px-5"
						onClick={onOpen}
						variant="outline"
					>
						<Reply aria-hidden="true" />
						Open conversation
					</Button>
					<p className="text-muted-foreground text-sm tabular-nums">
						{tl(
							"{messageCount, plural, one {{messageCountText} message} other {{messageCountText} messages}} in this conversation",
							{
								messageCount: thread.messageCount,
								messageCountText: String(thread.messageCount),
							}
						)}
					</p>
				</div>
			</div>
		</section>
	);
}
