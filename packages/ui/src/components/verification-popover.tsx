"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import {
	Popover,
	PopoverContent,
	PopoverDescription,
	PopoverHeader,
	PopoverTitle,
	PopoverTrigger,
} from "@ryu/ui/components/popover.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import {
	Badge as BadgeIcon,
	Check,
	Globe2,
	type LucideIcon,
	MailCheck,
	ShieldCheck,
} from "lucide-react";
import { isNativeText } from "../lib/native-primitive-observation.ts";

export type VerificationMethodKind =
	| "custom"
	| "domain"
	| "email"
	| "identity"
	| "organization"
	| "platform";

export interface VerificationMethod {
	kind: VerificationMethodKind;
	label: string;
}

export interface VerificationDetails {
	methods: readonly VerificationMethod[];
	verifiedSince?: string | null;
}

const METHOD_ICONS = {
	custom: ShieldCheck,
	domain: Globe2,
	email: MailCheck,
	identity: ShieldCheck,
	organization: BadgeIcon,
	platform: BadgeIcon,
} satisfies Record<VerificationMethodKind, LucideIcon>;

/** Format a server-provided ISO date with a stable UTC calendar date. */
export function formatVerificationDate(value?: string | null): string | null {
	if (!value) {
		return null;
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return null;
	}
	return new Intl.DateTimeFormat("en-US", {
		day: "numeric",
		month: "short",
		timeZone: "UTC",
		year: "numeric",
	}).format(date);
}

function VerificationMark({
	className,
	variant,
}: {
	className?: string;
	variant: "badge" | "shield";
}) {
	if (variant === "shield") {
		return (
			<ShieldCheck aria-hidden="true" className={cn("size-4", className)} />
		);
	}

	return (
		<span
			aria-hidden="true"
			className={cn(
				"relative inline-flex size-4 items-center justify-center",
				className
			)}
		>
			<BadgeIcon
				className="absolute inset-0 size-4"
				fill="currentColor"
				strokeWidth={1.5}
			/>
			<Check className="relative size-2.5 text-background" strokeWidth={3} />
		</span>
	);
}

type VerificationAppearance =
	| "default"
	| "publisher-gold-card"
	| "publisher-gold-hero"
	| "publisher-blue-card"
	| "publisher-blue-hero"
	| "publisher-dotted";

const publisherAppearanceClasses = {
	"publisher-gold-card":
		"text-publisher-verification-gold drop-shadow-(--publisher-verification-gold-shadow) dark:text-publisher-verification-gold-dark",
	"publisher-gold-hero":
		"text-publisher-verification-gold-hero drop-shadow-(--publisher-verification-gold-hero-shadow)",
	"publisher-blue-card": "text-status-info",
	"publisher-blue-hero": "text-publisher-verification-blue-hero",
	"publisher-dotted":
		"text-muted-foreground/70 opacity-50 transition-opacity focus-within:opacity-100 hover:opacity-100",
} satisfies Record<Exclude<VerificationAppearance, "default">, string>;

/**
 * A compact verification mark that explains its evidence on demand.
 *
 * `badge` is for a publisher or platform identity mark. `shield` is for a
 * supporting account signal such as a verified email or domain. The trigger is
 * always a real button so the disclosure works with a mouse, keyboard, and
 * assistive technology.
 */
export function VerificationPopover({
	appearance = "default",
	className,
	description,
	details,
	label,
	title,
	variant,
}: {
	appearance?: VerificationAppearance;
	className?: string;
	description?: string | null;
	details?: VerificationDetails | null;
	label?: string;
	title: string;
	variant: "badge" | "shield";
}) {
	const tl = useLiteralMessages();
	const markClassName =
		appearance === "default"
			? className
			: cn(publisherAppearanceClasses[appearance], className);
	const verifiedSince = formatVerificationDate(details?.verifiedSince);
	const methods = (details?.methods ?? []).filter(
		(method) =>
			method && isNativeText(method.label) && method.label.trim().length > 0
	);
	const triggerLabel =
		label ?? tl("Show verification details for {title}", { title });

	return (
		<Popover modal={false}>
			<PopoverTrigger
				aria-label={triggerLabel}
				className={cn(
					"pointer-events-auto relative z-10 inline-flex size-5 shrink-0 items-center justify-center rounded-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
					variant === "shield"
						? "text-status-success hover:text-status-success/80"
						: "hover:text-foreground",
					markClassName
				)}
				data-slot="verification-trigger"
				render={
					<button aria-label={triggerLabel} type="button">
						<VerificationMark variant={variant} />
					</button>
				}
			/>
			<PopoverContent
				align="start"
				className="w-[min(20rem,calc(100vw-2rem))] gap-3"
				data-slot="verification-popover"
				side="bottom"
			>
				<PopoverHeader>
					<PopoverTitle className="flex items-center gap-2">
						<VerificationMark
							className={
								variant === "shield" ? "text-status-success" : markClassName
							}
							variant={variant}
						/>
						{title}
					</PopoverTitle>
					{description ? (
						<PopoverDescription>{description}</PopoverDescription>
					) : null}
				</PopoverHeader>

				{verifiedSince ? (
					<div className="flex items-center justify-between gap-3 text-xs">
						<span className="text-muted-foreground">Verified since</span>
						<time
							className="font-medium tabular-nums"
							dateTime={details?.verifiedSince ?? undefined}
						>
							{verifiedSince}
						</time>
					</div>
				) : null}

				<div className="space-y-2">
					<p className="font-medium text-xs">Verified methods</p>
					{methods.length > 0 ? (
						<ul className="space-y-1.5">
							{methods.map((method) => {
								const MethodIcon = METHOD_ICONS[method.kind] ?? ShieldCheck;
								return (
									<li
										className="flex items-center gap-2 text-muted-foreground text-xs"
										key={`${method.kind}:${method.label}`}
									>
										<MethodIcon
											aria-hidden="true"
											className="size-3.5 text-status-success"
										/>
										<span>{method.label}</span>
									</li>
								);
							})}
						</ul>
					) : (
						<p className="text-muted-foreground text-xs">
							No additional verification methods are published.
						</p>
					)}
				</div>
			</PopoverContent>
		</Popover>
	);
}
