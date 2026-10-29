"use client";

import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

function InputGroup({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"group/input-group corner-squircle has-[textarea]:corner-squircle has-data-[align=block-end]:corner-squircle has-data-[align=block-start]:corner-squircle relative flex h-9 w-full min-w-0 items-center rounded-4xl border border-transparent bg-input/50 outline-none transition-[color,box-shadow,background-color] in-data-[slot=combobox-content]:focus-within:border-inherit in-data-[slot=combobox-content]:focus-within:ring-0 has-[>[data-align=block-end]]:h-auto has-[>[data-align=block-start]]:h-auto has-[>textarea]:h-auto has-[>[data-align=block-end]]:flex-col has-[>[data-align=block-start]]:flex-col has-[textarea]:rounded-2xl has-data-[align=block-end]:rounded-3xl has-data-[align=block-start]:rounded-3xl has-[[data-slot=input-group-control]:focus-visible]:border-ring has-[[data-slot][aria-invalid=true]]:border-destructive has-[[data-slot=input-group-control]:focus-visible]:ring-3 has-[[data-slot=input-group-control]:focus-visible]:ring-ring has-[[data-slot][aria-invalid=true]]:ring-3 has-[[data-slot][aria-invalid=true]]:ring-destructive/20 dark:has-[[data-slot][aria-invalid=true]]:ring-destructive/40 has-[>[data-align=inline-start]]:[&>input]:ps-1.5 has-[>[data-align=inline-end]]:[&>input]:pe-1.5 has-[>[data-align=block-end]]:[&>input]:pt-3 has-[>[data-align=block-start]]:[&>input]:pb-3",
				className
			)}
			data-slot="input-group"
			role="group"
			{...props}
		/>
	);
}

const inputGroupAddonVariants = cva(
	"**:data-[slot=kbd]:corner-squircle flex h-auto cursor-text select-none items-center justify-center gap-2 py-2 font-medium text-muted-foreground text-sm **:data-[slot=kbd]:rounded-3xl **:data-[slot=kbd]:bg-muted-foreground/10 **:data-[slot=kbd]:px-1.5 group-data-[disabled=true]/input-group:opacity-50 [&>svg:not([class*='size-'])]:size-4",
	{
		variants: {
			align: {
				"inline-start": "order-first ps-3 has-[>button]:-ms-1 has-[>kbd]:-ms-1",
				"inline-end": "order-last pe-3 has-[>button]:-me-1 has-[>kbd]:-me-1",
				"block-start":
					"order-first w-full justify-start px-3 pt-3 group-has-[>input]/input-group:pt-3.5 [.border-b]:pb-3.5",
				"block-end":
					"order-last w-full justify-start px-3 pb-3 group-has-[>input]/input-group:pb-3.5 [.border-t]:pt-3.5",
			},
		},
		defaultVariants: {
			align: "inline-start",
		},
	}
);

function InputGroupAddon({
	className,
	align = "inline-start",
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof inputGroupAddonVariants>) {
	return (
		<div
			className={cn(inputGroupAddonVariants({ align }), className)}
			data-align={align}
			data-slot="input-group-addon"
			onClick={(e) => {
				// SAFETY: React DOM dispatches this bubbling div click from its actual
				// rendered descendant and normalizes text targets to their parent.
				// Element owns closest for HTML and SVG descendants; no HTMLElement
				// subtype or arbitrary EventTarget capability is asserted. This scope
				// excludes manually injected or overridden event targets.
				if ((e.target as Element).closest("button")) {
					return;
				}
				e.currentTarget.parentElement?.querySelector("input")?.focus();
			}}
			role="group"
			{...props}
		/>
	);
}

const inputGroupButtonVariants = cva(
	"corner-squircle flex items-center gap-2 rounded-4xl text-sm shadow-none",
	{
		variants: {
			size: {
				xs: "corner-squircle h-6 gap-1 rounded-xl px-1.5 [&>svg:not([class*='size-'])]:size-3.5",
				sm: "",
				"icon-xs": "corner-squircle size-6 rounded-xl p-0 has-[>svg]:p-0",
				"icon-sm": "size-8 p-0 has-[>svg]:p-0",
			},
		},
		defaultVariants: {
			size: "xs",
		},
	}
);

function InputGroupButton({
	className,
	type = "button",
	variant = "ghost",
	size = "xs",
	...props
}: Omit<React.ComponentProps<typeof Button>, "size" | "type"> &
	VariantProps<typeof inputGroupButtonVariants> & {
		type?: "button" | "submit" | "reset";
	}) {
	return (
		<Button
			className={cn(inputGroupButtonVariants({ size }), className)}
			data-size={size}
			type={type}
			variant={variant}
			{...props}
		/>
	);
}

function InputGroupText({ className, ...props }: React.ComponentProps<"span">) {
	return (
		<span
			className={cn(
				"flex items-center gap-2 text-muted-foreground text-sm [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none",
				className
			)}
			{...props}
		/>
	);
}

function InputGroupInput({
	className,
	...props
}: React.ComponentProps<typeof Input>) {
	return (
		<Input
			className={cn(
				"flex-1 rounded-none border-0 bg-transparent shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
				className
			)}
			data-slot="input-group-control"
			{...props}
		/>
	);
}

function InputGroupTextarea({
	className,
	...props
}: React.ComponentProps<"textarea">) {
	return (
		<Textarea
			className={cn(
				"flex-1 resize-none rounded-none border-0 bg-transparent py-2.5 shadow-none ring-0 focus-visible:ring-0 aria-invalid:ring-0 dark:bg-transparent",
				className
			)}
			data-slot="input-group-control"
			{...props}
		/>
	);
}

export {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
	InputGroupText,
	InputGroupTextarea,
};
