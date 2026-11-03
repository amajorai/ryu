import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import type { LucideIcon } from "lucide-react";
import { landingCtaRowClass } from "../landing-typography.ts";
import { Cta, type CtaLink, outlineCtaClass } from "../sections.tsx";

/** A mailto action is a plain anchor (not a Next route) styled as a pill. */
function EmptyStateAction({
	action,
	variant,
}: {
	action: CtaLink;
	variant: "mono" | "outline";
}) {
	if (!action.href.startsWith("mailto:")) {
		return <Cta cta={action} variant={variant} />;
	}
	return (
		<a
			className={cn(
				buttonVariants({ variant }),
				"rounded-full",
				variant === "outline" && outlineCtaClass
			)}
			href={action.href}
		>
			{action.label}
		</a>
	);
}

/**
 * An honest "nothing here yet" panel: a heading, one sentence of why, and the
 * next useful step. Used where a list is editor-managed and may be empty (open
 * roles, events, press coverage), so the page states it instead of padding it.
 * The first action is the filled button; the rest are outlined. A `mailto:`
 * action (a press or contact address) renders as a plain anchor.
 */
export function EmptyState({
	title,
	body,
	actions,
	icon: Icon,
	headingLevel: Heading = "h3",
	testId,
	className,
}: {
	title: string;
	body: string;
	actions?: readonly CtaLink[];
	icon?: LucideIcon;
	headingLevel?: "h2" | "h3";
	testId?: string;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-start gap-4 rounded-2xl border border-border border-dashed p-8 md:p-10",
				className
			)}
			data-empty-state=""
			// A `data-slot` keeps the dashed outline: public-pages.css strips
			// borders from unslotted content divs.
			data-slot="empty-state"
			data-testid={testId}
		>
			{Icon ? (
				<span
					aria-hidden="true"
					className="flex size-10 items-center justify-center rounded-xl bg-muted text-foreground"
				>
					<Icon className="size-5" />
				</span>
			) : null}
			<div className="max-w-xl">
				<Heading className="font-heading font-medium text-foreground text-lg tracking-tight">
					{title}
				</Heading>
				<p className="mt-2 text-pretty text-muted-foreground text-sm leading-relaxed md:text-base">
					{body}
				</p>
			</div>
			{actions?.length ? (
				<div className={cn(landingCtaRowClass, "mt-2")}>
					{actions.map((action, index) => (
						<EmptyStateAction
							action={action}
							key={action.href}
							variant={index === 0 ? "mono" : "outline"}
						/>
					))}
				</div>
			) : null}
		</div>
	);
}
