import { Copy01Icon, Tick01Icon } from "@hugeicons/core-free-icons";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { MorphIconSwap } from "@ryu/ui/components/morph-icon.tsx";
import { useState } from "react";
import { sileo } from "sileo";
import { TitleTooltip } from "@/src/components/layout/overflow-tooltip.tsx";
import previewStyles from "../settings-preview.module.css";

/** How long the copied checkmark stays before reverting to the copy icon. */
const COPIED_RESET_MS = 1500;

/**
 * A right-aligned identifier control: the id renders blurred until the row is
 * hovered or focused, with a copy button pinned to the right. Used for the
 * organization id and user id in the Workspace / Account surfaces.
 *
 * These ids are not secrets (the org id rides in URLs, the user id in the JWT);
 * the blur is a cosmetic "reveal on intent" affordance, not a security control.
 * Reveal also triggers on keyboard focus so the value is reachable without a
 * pointer.
 */
export function CopyableId({
	value,
	label = "ID",
	className,
}: {
	className?: string;
	label?: string;
	value: string;
}) {
	const tl = useLiteralMessages();
	const [copied, setCopied] = useState(false);

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			sileo.success({ title: tl("Copied {label}", { label }) });
			setTimeout(() => setCopied(false), COPIED_RESET_MS);
		} catch {
			sileo.error({ title: "Copy failed" });
		}
	};

	return (
		<div
			className={`group flex items-center justify-end gap-2 ${previewStyles.identifierGroup} ${className ?? ""}`}
		>
			<TitleTooltip content={value}>
				<code
					className={`max-w-[240px] select-all truncate rounded bg-muted px-2 py-1 font-mono text-muted-foreground text-xs duration-150 ${previewStyles.identifier}`}
				>
					{value}
				</code>
			</TitleTooltip>
			<Button
				aria-label={tl("Copy {label}", { label })}
				className="shrink-0"
				onClick={copy}
				size="icon"
				variant="ghost"
			>
				<MorphIconSwap
					a={Copy01Icon}
					b={Tick01Icon}
					className="size-4"
					state={copied ? "b" : "a"}
				/>
			</Button>
		</div>
	);
}
