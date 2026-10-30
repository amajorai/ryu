import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { useEffect, useState } from "react";
import type { TerminalThreadRow } from "./terminal-model.ts";
import { type TerminalBlock, terminalBlockText } from "./terminal-output.tsx";

/** How long the copy action shows its confirmation. */
const COPIED_MS = 1200;

/** Copy a block's output; revealed on block hover or keyboard focus. */
export function BlockCopyButton({
	block,
	needsYou,
	now,
}: {
	block: TerminalBlock;
	needsYou: readonly TerminalThreadRow[];
	now: number;
}) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) {
			return;
		}
		const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
		return () => window.clearTimeout(timer);
	}, [copied]);
	const copy = async () => {
		const text = terminalBlockText(block, { needsYou, now });
		try {
			await navigator.clipboard.writeText(text);
			setCopied(true);
		} catch {
			// Clipboard access can be denied; the output stays selectable.
		}
	};
	const icon = copied ? Tick02Icon : Copy01Icon;
	return (
		<Button
			aria-label={copied ? "Copied" : "Copy output"}
			className="absolute top-2.5 @3xl/terminal:right-5 right-3 text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/block:opacity-100 motion-safe:transition-opacity"
			onClick={copy}
			size="icon-xs"
			variant="ghost"
		>
			<HugeiconsIcon aria-hidden="true" className="size-4" icon={icon} />
		</Button>
	);
}
