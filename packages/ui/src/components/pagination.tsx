"use client";

import {
	ArrowLeft01Icon,
	ArrowRight01Icon,
	MoreHorizontalCircle01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedString, useLocalizedText } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type * as React from "react";

function Pagination({
	"aria-label": ariaLabel,
	className,
	...props
}: React.ComponentProps<"nav">) {
	const localizedAriaLabel = useLocalizedString(ariaLabel ?? "pagination");
	return (
		<nav
			aria-label={localizedAriaLabel}
			className={cn("mx-auto flex w-full justify-center", className)}
			data-slot="pagination"
			{...props}
		/>
	);
}

function PaginationContent({
	className,
	...props
}: React.ComponentProps<"ul">) {
	return (
		<ul
			className={cn("flex items-center gap-1", className)}
			data-slot="pagination-content"
			{...props}
		/>
	);
}

function PaginationItem({ ...props }: React.ComponentProps<"li">) {
	return <li data-slot="pagination-item" {...props} />;
}

type PaginationLinkProps = {
	isActive?: boolean;
} & Pick<React.ComponentProps<typeof Button>, "size"> &
	React.ComponentProps<"a">;

function PaginationLink({
	className,
	isActive,
	size = "icon",
	...props
}: PaginationLinkProps) {
	return (
		<Button
			className={cn(className)}
			nativeButton={false}
			render={
				<a
					aria-current={isActive ? "page" : undefined}
					data-active={isActive}
					data-slot="pagination-link"
					{...props}
				/>
			}
			size={size}
			variant={isActive ? "outline" : "ghost"}
		/>
	);
}

function PaginationPrevious({
	className,
	text = "Previous",
	...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
	const localizedText = useLocalizedText(text, { literal: true });
	const localizedAriaLabel = useLocalizedString("Go to previous page");
	return (
		<PaginationLink
			aria-label={localizedAriaLabel}
			className={cn("pl-2!", className)}
			size="default"
			{...props}
		>
			<HugeiconsIcon
				data-icon="inline-start"
				icon={ArrowLeft01Icon}
				strokeWidth={2}
			/>
			<span className="hidden sm:block">{localizedText}</span>
		</PaginationLink>
	);
}

function PaginationNext({
	className,
	text = "Next",
	...props
}: React.ComponentProps<typeof PaginationLink> & { text?: string }) {
	const localizedText = useLocalizedText(text, { literal: true });
	const localizedAriaLabel = useLocalizedString("Go to next page");
	return (
		<PaginationLink
			aria-label={localizedAriaLabel}
			className={cn("pr-2!", className)}
			size="default"
			{...props}
		>
			<span className="hidden sm:block">{localizedText}</span>
			<HugeiconsIcon
				data-icon="inline-end"
				icon={ArrowRight01Icon}
				strokeWidth={2}
			/>
		</PaginationLink>
	);
}

function PaginationEllipsis({
	className,
	...props
}: React.ComponentProps<"span">) {
	return (
		<span
			aria-hidden
			className={cn(
				"flex size-9 items-center justify-center [&_svg:not([class*='size-'])]:size-4",
				className
			)}
			data-slot="pagination-ellipsis"
			{...props}
		>
			<HugeiconsIcon icon={MoreHorizontalCircle01Icon} strokeWidth={2} />
			<span className="sr-only">More pages</span>
		</span>
	);
}

export {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
};
