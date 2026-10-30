import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Kbd } from "@ryu/ui/components/kbd.tsx";
import { cn } from "@ryu/ui/lib/utils";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { STATUS_TONE } from "./planets-parts.tsx";

export const HEADING =
	"truncate font-heading font-semibold text-foreground leading-tight outline-none";
/** The list fades out above the composer instead of being cut flat. */
export const SCROLL_FADE =
	"min-h-0 flex-1 [mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]";

export function CloseButton({
	label,
	onClose,
}: {
	label: string;
	onClose: () => void;
}) {
	const tl = useLiteralMessages();
	return (
		<div className="flex shrink-0 items-center gap-1.5">
			<Kbd className="border border-border bg-transparent text-muted-foreground max-sm:hidden">
				Esc
			</Kbd>
			<Button
				aria-label={label}
				onClick={onClose}
				size="icon-sm"
				title={tl("{label} (Esc)", { label })}
				type="button"
				variant="ghost"
			>
				<X aria-hidden="true" />
			</Button>
		</div>
	);
}

export function Stat({
	label,
	tone,
	value,
}: {
	label: string;
	tone?: "attention" | "working" | "your-turn";
	value: number;
}) {
	return (
		<div className="flex flex-col gap-0.5 px-3 py-2.5">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd
				className={cn(
					"font-heading font-semibold text-foreground text-lg tabular-nums leading-tight",
					tone ? STATUS_TONE[tone] : null
				)}
			>
				{value}
			</dd>
		</div>
	);
}

export function EmptyNote({ children }: { children: ReactNode }) {
	return (
		<p className="rounded-xl border border-border border-dashed px-4 py-6 text-center text-muted-foreground text-sm">
			{children}
		</p>
	);
}
