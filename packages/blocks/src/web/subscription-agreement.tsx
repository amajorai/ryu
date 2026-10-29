"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox";
import { cn } from "@ryu/ui/lib/utils";
import { type ReactNode, useState } from "react";
import { docsHref } from "./data/resources.tsx";

export function SubscriptionAgreement({
	blocked = false,
	children,
	offerKey,
	quiet = false,
	terms,
}: {
	blocked?: boolean;
	children: (canContinue: boolean) => ReactNode;
	offerKey?: string;
	/**
	 * Public marketing treatment: the renewal disclosure is set as small muted
	 * print and the consent row is a 44px tap target.
	 */
	quiet?: boolean;
	terms: string;
}) {
	return (
		<SubscriptionAgreementOffer
			blocked={blocked}
			key={offerKey ?? terms}
			quiet={quiet}
			terms={terms}
		>
			{children}
		</SubscriptionAgreementOffer>
	);
}

function SubscriptionAgreementOffer({
	blocked,
	children,
	quiet,
	terms,
}: {
	blocked: boolean;
	children: (canContinue: boolean) => ReactNode;
	quiet: boolean;
	terms: string;
}) {
	const tl = useLiteralMessages();
	const [accepted, setAccepted] = useState(false);
	return (
		<div className="w-full space-y-3">
			<div className="space-y-2 text-sm">
				<p className={cn(quiet && "text-muted-foreground text-xs")}>
					{tl(
						"{terms} Cancel before your next billing date from Organization billing or Billing in your account menu",
						{ terms }
					)}
				</p>
				<label
					className={cn(
						"flex items-start gap-2",
						quiet && "min-h-11 cursor-pointer items-center"
					)}
				>
					<Checkbox
						checked={accepted}
						disabled={blocked}
						onCheckedChange={(checked) => setAccepted(checked === true)}
					/>
					<span>
						I agree to automatic renewal and the{" "}
						<a className="underline" href={docsHref("/docs/legal/terms")}>
							subscription terms
						</a>
					</span>
				</label>
			</div>
			{children(!blocked && accepted)}
		</div>
	);
}
