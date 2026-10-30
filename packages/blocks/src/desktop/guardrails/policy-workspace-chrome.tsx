"use client";

import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@ryu/ui/components/button";

export function StatusLine({
	error,
	success,
}: {
	error: string | null;
	success: string | null;
}) {
	if (error) {
		return (
			<p className="px-3.5 text-sm text-status-destructive" role="alert">
				{error}
			</p>
		);
	}
	if (success) {
		return (
			<p
				aria-live="polite"
				className="px-3.5 text-sm text-status-success"
				role="status"
			>
				{success}
			</p>
		);
	}
	return null;
}

export function SubpageHeader({
	hint,
	onBack,
	title,
}: {
	hint?: string;
	onBack: () => void;
	title: string;
}) {
	return (
		<div className="flex flex-col gap-1">
			<Button
				appearance="settings-back"
				className="-ml-2 w-fit"
				onClick={onBack}
				size="sm"
				variant="ghost-muted"
			>
				<HugeiconsIcon className="size-4" icon={ArrowLeft01Icon} />
				Policies
			</Button>
			<h3
				className="w-fit rounded-md px-0.5 font-medium text-base outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
				data-policy-subpage-heading=""
				tabIndex={-1}
			>
				{title}
			</h3>
			{hint ? (
				<p className="px-0.5 text-muted-foreground text-sm leading-snug">
					{hint}
				</p>
			) : null}
		</div>
	);
}
