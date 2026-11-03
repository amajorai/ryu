"use client";

import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils";
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

const RESET_AFTER_MS = 2000;

/**
 * Copies a command or snippet. The visible label switches to "Copied" for two
 * seconds and the same text is announced through a polite live region, so the
 * confirmation does not rely on the icon change alone.
 */
export function CopyButton({
	text,
	label = "Copy",
	className,
}: {
	text: string;
	/** Accessible name and visible label; a literal, localized like the footer copy. */
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);
	const idleLabel = useLocalizedText(label, { literal: true });
	const copiedLabel = useLocalizedText("Copied", { literal: true });

	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = setTimeout(() => setCopied(false), RESET_AFTER_MS);
		return () => clearTimeout(timer);
	}, [copied]);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Clipboard access can be refused (insecure context, permissions);
			// the text stays selectable in the block beside the button.
			setCopied(false);
		}
	};

	const Icon = copied ? Check : Copy;
	// The live region sits beside the button, not inside it: inside, it doubles
	// the button's name ("Copied Copied") and some readers skip live changes in
	// the focused control.
	return (
		<>
			<button
				className={cn(
					"inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 font-medium text-muted-foreground text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
					className
				)}
				data-copied={copied ? "" : undefined}
				data-product-copy=""
				onClick={copy}
				type="button"
			>
				<Icon aria-hidden="true" className="size-3.5" />
				<span>{copied ? copiedLabel : idleLabel}</span>
			</button>
			<span aria-live="polite" className="sr-only" data-copy-status="">
				{copied ? copiedLabel : null}
			</span>
		</>
	);
}
