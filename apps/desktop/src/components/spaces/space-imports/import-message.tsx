import { useLiteralMessages } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { describeImportMessage } from "./import-failure-copy.ts";

/**
 * The failure or "Skipped …" note of one import row. Each source's error reads
 * as a translated sentence after its file name; provider detail and file names
 * are user or third-party text, so the DOM localizer leaves them (and the
 * already translated sentence) alone; only an unmatched stored line is left
 * for its exact-catalog lookup.
 */
export function ImportMessage({
	failed,
	message,
}: {
	failed: boolean;
	message: string | null;
}) {
	const tl = useLiteralMessages();
	const copy = describeImportMessage(message, tl, { failed });
	if (!copy) {
		return null;
	}
	const tone = failed ? "text-status-destructive" : "text-muted-foreground";
	return (
		<div className={cn("mt-2 flex flex-col gap-1 text-xs", tone)}>
			{copy.skippedHeading ? <p>{copy.skippedHeading}</p> : null}
			<ul className="flex flex-col gap-1">
				{copy.lines.map((line, index) => (
					<li
						className="min-w-0 break-words"
						// The stored message has no ids; the order is stable per row.
						// biome-ignore lint/suspicious/noArrayIndexKey: lines are positional pieces of one stored string.
						key={index}
					>
						{line.file ? (
							<span className="font-medium" data-ryu-i18n="off">
								{line.file}
							</span>
						) : null}
						{line.file ? " · " : null}
						<span data-ryu-i18n={line.translated ? "off" : undefined}>
							{line.sentence}
						</span>
						{line.detail ? (
							<span className="block text-muted-foreground" data-ryu-i18n="off">
								{line.detail}
							</span>
						) : null}
					</li>
				))}
			</ul>
		</div>
	);
}
