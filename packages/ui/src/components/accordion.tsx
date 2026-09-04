"use client";

import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { ArrowDown01Icon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLocalizedText } from "@ryu/i18n/react";
import { cn } from "@ryu/ui/lib/utils.ts";
import { FadeOverflowTextChildren } from "./fade-overflow-text.tsx";

function Accordion({ className, ...props }: AccordionPrimitive.Root.Props) {
	return (
		<AccordionPrimitive.Root
			className={cn(
				"flex w-full flex-col overflow-hidden rounded-2xl border",
				className
			)}
			data-slot="accordion"
			{...props}
		/>
	);
}

function AccordionItem({ className, ...props }: AccordionPrimitive.Item.Props) {
	return (
		<AccordionPrimitive.Item
			className={cn("not-last:border-b data-open:bg-muted/50", className)}
			data-slot="accordion-item"
			{...props}
		/>
	);
}

function AccordionTrigger({
	className,
	children,
	...props
}: AccordionPrimitive.Trigger.Props) {
	const localizedChildren = useLocalizedText(children, { literal: true });
	return (
		<AccordionPrimitive.Header className="flex">
			<AccordionPrimitive.Trigger
				className={cn(
					"group/accordion-trigger relative flex flex-1 items-start justify-between gap-4 border border-transparent p-4 text-left font-medium text-sm outline-none transition-all aria-disabled:pointer-events-none aria-disabled:opacity-50 **:data-[slot=accordion-trigger-icon]:ml-auto **:data-[slot=accordion-trigger-icon]:size-4 **:data-[slot=accordion-trigger-icon]:text-muted-foreground",
					className
				)}
				data-slot="accordion-trigger"
				{...props}
			>
				<FadeOverflowTextChildren className="flex-1">
					{localizedChildren}
				</FadeOverflowTextChildren>
				<HugeiconsIcon
					className="pointer-events-none shrink-0 group-aria-expanded/accordion-trigger:hidden"
					data-slot="accordion-trigger-icon"
					icon={ArrowDown01Icon}
					strokeWidth={2}
				/>
				<HugeiconsIcon
					className="pointer-events-none hidden shrink-0 group-aria-expanded/accordion-trigger:inline"
					data-slot="accordion-trigger-icon"
					icon={ArrowUp01Icon}
					strokeWidth={2}
				/>
			</AccordionPrimitive.Trigger>
		</AccordionPrimitive.Header>
	);
}

type AccordionContentProps = AccordionPrimitive.Panel.Props & {
	/** Override the panel wrapper layout without changing the inner content styles. */
	panelClassName?: string;
};

function AccordionContent({
	className,
	panelClassName,
	children,
	...props
}: AccordionContentProps) {
	return (
		<AccordionPrimitive.Panel
			className={cn(
				"overflow-hidden px-4 text-sm data-closed:animate-accordion-up data-open:animate-accordion-down",
				panelClassName
			)}
			data-slot="accordion-content"
			{...props}
		>
			<div
				className={cn(
					"h-(--accordion-panel-height) pt-0 pb-4 data-ending-style:h-0 data-starting-style:h-0 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
					className
				)}
			>
				{children}
			</div>
		</AccordionPrimitive.Panel>
	);
}

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger };
