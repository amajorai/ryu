import {
	ArrowDown01Icon,
	ArrowRight01Icon,
	Cancel01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { type ReactNode, useId, useState } from "react";
import { formatDecimal } from "../locale-format.ts";
import { attachmentLine, type FeedbackAttachment } from "./feedback-tool.ts";

const NOTE_CLASS = "text-muted-foreground text-xs";

/** The expandable list of what the app would attach. Every line can go. */
export function AttachedDetails({
	attachments,
	onRemove,
}: {
	attachments: readonly FeedbackAttachment[] | null;
	onRemove: (id: string) => void;
}) {
	const tl = useLiteralMessages();
	// Open from the start: what would be sent is on screen before the send
	// button is, not behind a click.
	const [open, setOpen] = useState(true);
	const listId = useId();
	let content: ReactNode;
	if (attachments === null) {
		content = <p className={NOTE_CLASS}>Reading app details</p>;
	} else if (attachments.length === 0) {
		content = <p className={NOTE_CLASS}>Nothing is attached.</p>;
	} else {
		content = (
			<ul className="flex flex-col gap-1">
				{attachments.map((attachment) => (
					<li
						className="flex items-start gap-1 rounded-md bg-muted/50 py-0.5 ps-2 pe-0.5"
						key={attachment.id}
					>
						{/* Report text, sent as written: never translated in place. */}
						<span
							className="min-w-0 flex-1 break-words py-0.5 font-mono text-xs"
							data-ryu-i18n="off"
							dir="auto"
						>
							{attachmentLine(attachment)}
						</span>
						<Button
							aria-label={tl("Remove {label}", { label: attachment.label })}
							onClick={() => onRemove(attachment.id)}
							size="icon-xs"
							variant="ghost"
						>
							<HugeiconsIcon aria-hidden icon={Cancel01Icon} />
						</Button>
					</li>
				))}
			</ul>
		);
	}
	return (
		<div className="flex flex-col gap-1.5">
			<button
				aria-controls={listId}
				aria-expanded={open}
				className="flex w-fit items-center gap-1 rounded-md text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
				onClick={() => setOpen((value) => !value)}
				type="button"
			>
				<HugeiconsIcon
					aria-hidden
					className="size-3.5 rtl:-scale-x-100"
					icon={open ? ArrowDown01Icon : ArrowRight01Icon}
				/>
				<span>What is attached</span>
				{attachments ? (
					<span
						className="rounded-full bg-muted px-1.5 tabular-nums"
						data-testid="feedback-attached-count"
					>
						{formatDecimal(attachments.length, 0)}
					</span>
				) : null}
			</button>
			<div hidden={!open} id={listId}>
				{content}
			</div>
		</div>
	);
}
