import { Cancel01Icon, MailReply01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { InputBar } from "@ryu/blocks/desktop/agent-elements/input-bar.tsx";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import type { QuickReplyRequest } from "@/src/store/useQuickReplyStore.ts";

interface QuickReplyComposerProps {
	onClose: () => void;
	onSubmit: (content: string) => void;
	request: QuickReplyRequest | null;
}

/** A lightweight floating send surface for replying to a sidebar conversation. */
export function QuickReplyComposer({
	onClose,
	onSubmit,
	request,
}: QuickReplyComposerProps) {
	const tl = useLiteralMessages();
	const [draft, setDraft] = useState("");

	useEffect(() => {
		setDraft("");
	}, [request?.conversationId, request?.targetUrl]);

	useEffect(() => {
		if (!request) {
			return;
		}
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") {
				return;
			}
			event.preventDefault();
			onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose, request]);

	if (!request) {
		return null;
	}

	return (
		<div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex justify-center px-4">
			<div
				className="pointer-events-auto w-full max-w-2xl"
				data-testid="quick-reply-composer"
			>
				<InputBar
					autoFocus
					className="!px-0 !pb-0"
					compact
					composerHeader={
						<div className="flex min-w-0 items-center justify-between gap-3 border-border/50 border-b px-3 py-2">
							<div className="flex min-w-0 items-center gap-2 text-xs">
								<HugeiconsIcon
									className="size-3.5 shrink-0 text-primary"
									icon={MailReply01Icon}
								/>
								<span className="shrink-0 font-medium">Quick reply</span>
								<span className="text-muted-foreground/70">to</span>
								<span
									className="truncate text-muted-foreground"
									title={request.title}
								>
									{request.title}
								</span>
							</div>
							<Button
								aria-label="Close quick reply"
								className="size-7 shrink-0"
								onClick={onClose}
								size="icon"
								title="Close quick reply"
								type="button"
								variant="ghost-muted"
							>
								<HugeiconsIcon className="size-3.5" icon={Cancel01Icon} />
							</Button>
						</div>
					}
					onChange={setDraft}
					onSend={({ content }) => onSubmit(content)}
					onStop={() => undefined}
					placeholder={tl("Reply to {title}…", { title: request.title })}
					status="ready"
					value={draft}
				/>
			</div>
		</div>
	);
}
