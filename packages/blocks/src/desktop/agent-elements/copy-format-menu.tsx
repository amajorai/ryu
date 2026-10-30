import {
	ArrowDown01Icon,
	Copy01Icon,
	Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ryu/ui/components/dropdown-menu";
import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";
import { cn } from "@ryu/ui/lib/utils";
import { useEffect, useRef, useState } from "react";

export type ClipboardValue = Blob | string;

/** Write text and optional rich clipboard representations with a text fallback. */
export async function writeClipboardPayload(
	values: Record<string, ClipboardValue>,
	fallbackText?: string
): Promise<void> {
	if (globalThis.navigator === undefined || !navigator.clipboard) {
		throw new Error("Clipboard API not available");
	}

	if (navigator.clipboard.write && globalThis.ClipboardItem !== undefined) {
		const blobs: Record<string, Blob> = {};
		for (const [mimeType, value] of Object.entries(values)) {
			blobs[mimeType] =
				value instanceof Blob ? value : new Blob([value], { type: mimeType });
		}
		await navigator.clipboard.write([new ClipboardItem(blobs)]);
		return;
	}

	const text = fallbackText ?? values["text/plain"];
	if (!(isNativeText(text) && navigator.clipboard.writeText)) {
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
						appearance="clipboard-format-copy"
						aria-label={ariaLabel}
						className={cn(className)}
						data-copy-state={failed ? "error" : copied ? "copied" : "idle"}
						data-testid={dataTestId}
						title={failed ? "Copy failed" : ariaLabel}
						type="button"
						variant="ghost"
					>
						{copied ? (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={Tick02Icon}
							/>
						) : (
							<HugeiconsIcon
								aria-hidden="true"
								className="size-3.5"
								icon={Copy01Icon}
							/>
						)}
						<span className="hidden sm:inline">Copy</span>
						<HugeiconsIcon
							aria-hidden="true"
							className="size-3"
							icon={ArrowDown01Icon}
						/>
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
