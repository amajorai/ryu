import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { cn } from "@ryu/ui/lib/utils";
import { IconCheck, IconChevronDown, IconCopy } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";

export type ClipboardValue = Blob | string;

/** Write text and optional rich clipboard representations with a text fallback. */
export async function writeClipboardPayload(
	values: Record<string, ClipboardValue>,
	fallbackText?: string
): Promise<void> {
	if (typeof navigator === "undefined" || !navigator.clipboard) {
		throw new Error("Clipboard API not available");
	}

	if (navigator.clipboard.write && typeof ClipboardItem !== "undefined") {
		const blobs: Record<string, Blob> = {};
		for (const [mimeType, value] of Object.entries(values)) {
			blobs[mimeType] =
				value instanceof Blob ? value : new Blob([value], { type: mimeType });
		}
		await navigator.clipboard.write([new ClipboardItem(blobs)]);
		return;
	}

	const text = fallbackText ?? values["text/plain"];
	if (typeof text !== "string" || !navigator.clipboard.writeText) {
		throw new Error("Clipboard API not available");
	}
	await navigator.clipboard.writeText(text);
}

export interface CopyFormatOption {
	id: string;
	label: string;
}

export function CopyFormatMenu({
	ariaLabel,
	className,
	dataTestId,
	onCopy,
	options,
}: {
	ariaLabel: string;
	className?: string;
	dataTestId?: string;
	onCopy: (format: string) => Promise<void> | void;
	options: readonly CopyFormatOption[];
}) {
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	const timerRef = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
			}
		},
		[]
	);

	const handleCopy = async (format: string) => {
		try {
			await onCopy(format);
			setCopied(true);
			setFailed(false);
			if (timerRef.current !== null) {
				window.clearTimeout(timerRef.current);
			}
			timerRef.current = window.setTimeout(() => {
				setCopied(false);
				timerRef.current = null;
			}, 1800);
		} catch {
			setFailed(true);
		}
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button
						aria-label={ariaLabel}
						className={cn(
							"h-7 gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground hover:text-foreground",
							className
						)}
						data-copy-state={failed ? "error" : copied ? "copied" : "idle"}
						data-testid={dataTestId}
						title={failed ? "Copy failed" : ariaLabel}
						type="button"
						variant="ghost"
					>
						{copied ? (
							<IconCheck aria-hidden="true" className="size-3.5" />
						) : (
							<IconCopy aria-hidden="true" className="size-3.5" />
						)}
						<span className="hidden sm:inline">Copy</span>
						<IconChevronDown aria-hidden="true" className="size-3" />
					</Button>
				}
			/>
			<DropdownMenuContent align="end" className="min-w-44">
				{options.map((option) => (
					<DropdownMenuItem
						data-copy-format={option.id}
						key={option.id}
						onClick={() => void handleCopy(option.id)}
					>
						{option.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
