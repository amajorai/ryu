import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";

/** Back to the contact list; only shown at narrow widths. */
export function BackButton({ onBack }: { onBack: () => void }) {
	return (
		<Button
			aria-label="Back to messages"
			className="-ml-1 @min-[900px]:hidden text-primary hover:text-primary"
			onClick={onBack}
			size="icon-sm"
			variant="ghost"
		>
			<ChevronLeft aria-hidden="true" className="size-5" />
		</Button>
	);
}

export function HeaderBar({ children }: { children: ReactNode }) {
	return (
		<header className="flex h-16 shrink-0 items-center gap-3 border-border border-b bg-background/95 px-5 backdrop-blur">
			{children}
		</header>
	);
}

/**
 * The header's name. App UI pins headings to the heading face at weight 500,
 * so the visible text is a sans span at the list's semibold weight.
 */
export function HeaderTitle({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<h2 className={cn("truncate leading-5", className)}>
			<span className="font-sans font-semibold text-[15px]">{children}</span>
		</h2>
	);
}
