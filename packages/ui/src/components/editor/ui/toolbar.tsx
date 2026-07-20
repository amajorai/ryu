"use client";

import * as ToolbarPrimitive from "@radix-ui/react-toolbar";
import {
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuSeparator,
} from "@ryu/ui/components/editor/ui/dropdown-menu.tsx";
import { Separator } from "@ryu/ui/components/editor/ui/separator.tsx";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ryu/ui/components/editor/ui/tooltip.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";
import { ChevronDown } from "lucide-react";
import {
	type ComponentProps,
	type ComponentPropsWithoutRef,
	type ElementType,
	type ReactNode,
	useEffect,
	useState,
} from "react";

export function Toolbar({
	className,
	...props
}: ComponentProps<typeof ToolbarPrimitive.Root>) {
	return (
		<ToolbarPrimitive.Root
			className={cn("relative flex select-none items-center", className)}
			{...props}
		/>
	);
}

export function ToolbarToggleGroup({
	className,
	...props
}: ComponentProps<typeof ToolbarPrimitive.ToolbarToggleGroup>) {
	return (
		<ToolbarPrimitive.ToolbarToggleGroup
			className={cn("flex items-center", className)}
			{...props}
		/>
	);
}

export function ToolbarLink({
	className,
	...props
}: ComponentProps<typeof ToolbarPrimitive.Link>) {
	return (
		<ToolbarPrimitive.Link
			className={cn("font-medium underline underline-offset-4", className)}
			{...props}
		/>
	);
}

export function ToolbarSeparator({
	className,
	...props
}: ComponentProps<typeof ToolbarPrimitive.Separator>) {
	return (
		<ToolbarPrimitive.Separator
			className={cn("mx-2 my-1 w-px shrink-0 bg-border", className)}
			{...props}
		/>
	);
}

// From toggleVariants
const toolbarButtonVariants = cva(
	"inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium text-sm outline-none transition-[color,box-shadow] hover:bg-muted hover:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-accent-foreground aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
	{
		defaultVariants: {
			size: "default",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-9 min-w-9 px-2",
				lg: "h-10 min-w-10 px-2.5",
				sm: "h-8 min-w-8 px-1.5",
			},
			variant: {
				default: "bg-transparent",
				outline:
					"border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground",
			},
		},
	}
);

const dropdownArrowVariants = cva(
	cn(
		"inline-flex items-center justify-center rounded-r-md font-medium text-foreground text-sm transition-colors disabled:pointer-events-none disabled:opacity-50"
	),
	{
		defaultVariants: {
			size: "sm",
			variant: "default",
		},
		variants: {
			size: {
				default: "h-9 w-6",
				lg: "h-10 w-8",
				sm: "h-8 w-4",
			},
			variant: {
				default:
					"bg-transparent hover:bg-muted hover:text-muted-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground",
				outline:
					"border border-input border-l-0 bg-transparent hover:bg-accent hover:text-accent-foreground",
			},
		},
	}
);

type ToolbarButtonProps = {
	isDropdown?: boolean;
	pressed?: boolean;
} & Omit<
	ComponentPropsWithoutRef<typeof ToolbarToggleItem>,
	"asChild" | "value"
> &
	VariantProps<typeof toolbarButtonVariants>;

export const ToolbarButton = withTooltip(function ToolbarButton({
	children,
	className,
	isDropdown,
	pressed,
	size = "sm",
	variant,
	...props
}: ToolbarButtonProps) {
	// A single native <button> carrying its toggle state via `aria-pressed`
	// (styled by the `aria-pressed:` variants above). This is intentionally NOT
	// wrapped in a Radix ToolbarToggleGroup: the group renders a `<div>` root,
	// which (a) becomes a `<button>`-inside-`<div>`-inside-`<button>` once the
	// Base UI tooltip/dropdown trigger renders onto it and (b) trips Base UI's
	// `nativeButton` dev check because the trigger expects a native button.
	// Keeping a lone button lets the tooltip/dropdown trigger's `render` prop
	// merge cleanly onto one real button element.
	return typeof pressed === "boolean" ? (
		<ToolbarPrimitive.Button
			aria-pressed={pressed}
			className={cn(
				toolbarButtonVariants({
					size,
					variant,
				}),
				isDropdown && "justify-between gap-1 pr-1",
				className
			)}
			{...props}
		>
			{isDropdown ? (
				<>
					<div className="flex flex-1 items-center gap-2 whitespace-nowrap">
						{children}
					</div>
					<div>
						<ChevronDown className="size-3.5 text-muted-foreground" data-icon />
					</div>
				</>
			) : (
				children
			)}
		</ToolbarPrimitive.Button>
	) : (
		<ToolbarPrimitive.Button
			className={cn(
				toolbarButtonVariants({
					size,
					variant,
				}),
				isDropdown && "pr-1",
				className
			)}
			{...props}
		>
			{children}
		</ToolbarPrimitive.Button>
	);
});

export function ToolbarSplitButton({
	className,
	...props
}: ComponentPropsWithoutRef<typeof ToolbarButton>) {
	return (
		<ToolbarButton
			className={cn("group flex gap-0 px-0 hover:bg-transparent", className)}
			{...props}
		/>
	);
}

type ToolbarSplitButtonPrimaryProps = Omit<
	ComponentPropsWithoutRef<typeof ToolbarToggleItem>,
	"value"
> &
	VariantProps<typeof toolbarButtonVariants>;

export function ToolbarSplitButtonPrimary({
	children,
	className,
	size = "sm",
	variant,
	...props
}: ToolbarSplitButtonPrimaryProps) {
	return (
		<span
			className={cn(
				toolbarButtonVariants({
					size,
					variant,
				}),
				"rounded-r-none",
				"group-data-[pressed=true]:bg-accent group-data-[pressed=true]:text-accent-foreground",
				className
			)}
			{...props}
		>
			{children}
		</span>
	);
}

export function ToolbarSplitButtonSecondary({
	className,
	size,
	variant,
	...props
}: ComponentPropsWithoutRef<"span"> &
	VariantProps<typeof dropdownArrowVariants>) {
	return (
		<span
			className={cn(
				dropdownArrowVariants({
					size,
					variant,
				}),
				"group-data-[pressed=true]:bg-accent group-data-[pressed=true]:text-accent-foreground",
				className
			)}
			onClick={(e) => e.stopPropagation()}
			role="button"
			{...props}
		>
			<ChevronDown className="size-3.5 text-muted-foreground" data-icon />
		</span>
	);
}

export function ToolbarToggleItem({
	className,
	size = "sm",
	variant,
	...props
}: ComponentProps<typeof ToolbarPrimitive.ToggleItem> &
	VariantProps<typeof toolbarButtonVariants>) {
	return (
		<ToolbarPrimitive.ToggleItem
			className={cn(toolbarButtonVariants({ size, variant }), className)}
			{...props}
		/>
	);
}

export function ToolbarGroup({ children, className }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"group/toolbar-group",
				"relative hidden has-[button]:flex",
				className
			)}
		>
			<div className="flex items-center">{children}</div>

			<div className="group-last/toolbar-group:hidden! mx-1.5 py-0.5">
				<Separator orientation="vertical" />
			</div>
		</div>
	);
}

type TooltipProps<T extends ElementType> = {
	tooltip?: ReactNode;
	tooltipContentProps?: Omit<
		ComponentPropsWithoutRef<typeof TooltipContent>,
		"children"
	>;
	tooltipProps?: Omit<ComponentPropsWithoutRef<typeof Tooltip>, "children">;
	tooltipTriggerProps?: ComponentPropsWithoutRef<typeof TooltipTrigger>;
} & ComponentProps<T>;

function withTooltip<T extends ElementType>(Component: T) {
	return function ExtendComponent({
		tooltip,
		tooltipContentProps,
		tooltipProps,
		tooltipTriggerProps,
		...props
	}: TooltipProps<T>) {
		const [mounted, setMounted] = useState(false);

		useEffect(() => {
			setMounted(true);
		}, []);

		const component = <Component {...(props as ComponentProps<T>)} />;

		if (tooltip && mounted) {
			return (
				<Tooltip {...tooltipProps}>
					{/* Base UI has no `asChild`; `render` merges the trigger onto the
					    child element instead of wrapping it in its own <button> (which
					    would nest a <button> inside a <button>). */}
					<TooltipTrigger render={component} {...tooltipTriggerProps} />

					<TooltipContent {...tooltipContentProps}>{tooltip}</TooltipContent>
				</Tooltip>
			);
		}

		return component;
	};
}

export function ToolbarMenuGroup({
	children,
	className,
	label,
	...props
}: ComponentProps<typeof DropdownMenuRadioGroup> & { label?: string }) {
	return (
		<>
			<DropdownMenuSeparator
				className={cn(
					"hidden",
					"mb-0 shrink-0 peer-has-[[role=menuitem]]/menu-group:block peer-has-[[role=menuitemradio]]/menu-group:block peer-has-[[role=option]]/menu-group:block"
				)}
			/>

			<DropdownMenuRadioGroup
				{...props}
				className={cn(
					"hidden",
					"peer/menu-group group/menu-group my-1.5 has-[[role=menuitem]]:block has-[[role=menuitemradio]]:block has-[[role=option]]:block",
					className
				)}
			>
				{label && (
					<DropdownMenuLabel className="select-none font-semibold text-muted-foreground text-xs">
						{label}
					</DropdownMenuLabel>
				)}
				{children}
			</DropdownMenuRadioGroup>
		</>
	);
}
