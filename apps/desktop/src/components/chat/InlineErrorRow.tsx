import { Alert02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";

export interface InlineErrorRowProps {
	className?: string;
	/** The raw failure (status line, server text). Never shown, only copied. */
	details?: string | null;
	/** One plain sentence that says what failed. */
	message: string;
	onRetry?: () => void;
	retryLabel?: string;
	/**
	 * Let the sentence wrap instead of truncating to one line. Use it when the
	 * message is dynamic (a validation sentence, the server's reason a save
	 * failed) and the reader has to see all of it.
	 */
	wrap?: boolean;
}

/**
 * A single quiet `h-8` error row: a muted alert icon in the status colour, one
 * sentence, a ghost Retry and a "Copy details" action. Raw failure text (HTTP
 * status lines, URLs) never renders; it is one click away for a bug report.
 */
export function InlineErrorRow({
	className,
	details,
	message,
	onRetry,
	retryLabel = "Retry",
	wrap = false,
}: InlineErrorRowProps) {
	const copyDetails = details
		? () => {
				navigator.clipboard
					.writeText(details)
					.then(() => toast.success("Details copied"))
					.catch(() => toast.error("Could not copy the details"));
			}
		: undefined;
	return (
		<div
			className={cn(
				"text-(length:--text-detail) flex min-w-0 items-center gap-2 text-muted-foreground leading-(--text-detail--line-height)",
				wrap ? "min-h-8 py-1" : "h-8",
				className
			)}
			role="alert"
		>
			<HugeiconsIcon
				aria-hidden="true"
				className="size-3.5 shrink-0 text-status-destructive"
				icon={Alert02Icon}
			/>
			<span className={cn("min-w-0", wrap ? "text-pretty" : "truncate")}>
				{message}
			</span>
			{onRetry ? (
				<Button onClick={onRetry} size="xs" type="button" variant="ghost">
					{retryLabel}
				</Button>
			) : null}
			{copyDetails ? (
				<Button
					className="text-muted-foreground"
					onClick={copyDetails}
					size="xs"
					type="button"
					variant="ghost"
				>
					Copy details
				</Button>
			) : null}
		</div>
	);
}
