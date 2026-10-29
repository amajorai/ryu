import { cn } from "@ryu/ui/lib/utils.ts";
import { cva, type VariantProps } from "class-variance-authority";

const skeletonVariants = cva(
	"corner-squircle animate-skeleton motion-reduce:animate-none",
	{
		variants: {
			radius: {
				default: "rounded-2xl",
				block: "rounded",
				pill: "rounded-full",
				row: "rounded-lg",
				dense: "rounded-md",
				panel: "rounded-xl",
			},
			tone: {
				default: "bg-muted",
				"paper-heading":
					"bg-space-paper-heading-placeholder dark:bg-space-paper-heading-placeholder-dark",
				"paper-line":
					"bg-space-paper-line-placeholder dark:bg-space-paper-line-placeholder-dark",
				docsPrimary30: "bg-docs-preview-primary/30",
				docsBackground: "bg-docs-preview-background",
				docsBackground60: "bg-docs-preview-background/60",
				docsBackground70: "bg-docs-preview-background/70",
				docsBackground80: "bg-docs-preview-background/80",
				docsSecondary: "bg-docs-preview-secondary",
				docsSecondary70: "bg-docs-preview-secondary/70",
			},
		},
		defaultVariants: { radius: "default", tone: "default" },
	}
);

function Skeleton({
	className,
	radius,
	tone,
	...props
}: React.ComponentProps<"div"> & VariantProps<typeof skeletonVariants>) {
	return (
		<div
			className={cn(skeletonVariants({ radius, tone }), className)}
			data-slot="skeleton"
			{...props}
		/>
	);
}

// Stable keys: placeholder rows never reorder, and index keys trip the linter.
const ROW_KEYS = [
	"row-1",
	"row-2",
	"row-3",
	"row-4",
	"row-5",
	"row-6",
	"row-7",
	"row-8",
] as const;

/**
 * A stack of row placeholders for a list or panel whose data is still loading.
 * Use it instead of a centered spinner: the rows hold the layout in place, so the
 * real content lands without a jump. Keep spinners for user-started actions.
 */
function SkeletonRows({
	className,
	label = "Loading",
	inset = "default",
	rows = 3,
	size = "default",
	spacing = "default",
}: {
	className?: string;
	/** Announced to assistive tech; the rows themselves are decorative. */
	label?: string;
	rows?: number;
	/** Padding within loading panels, catalog surfaces, and nested navigation rows. */
	inset?:
		| "default"
		| "comfortable"
		| "panel"
		| "detail"
		| "catalog"
		| "workflow-row"
		| "panel-horizontal"
		| "navigation";
	/** `sm` for dense surfaces such as sidebar rows and menus. */
	size?: "default" | "sm";
	spacing?:
		| "default"
		| "compact-panel"
		| "comfortable"
		| "panel"
		| "budget"
		| "spacious"
		| "generous"
		| "review"
		| "library"
		| "tight"
		| "compact-stack"
		| "section"
		| "expanded"
		| "status";
}) {
	const count = Math.max(1, Math.min(rows, ROW_KEYS.length));
	return (
		<div
			aria-busy="true"
			aria-label={label}
			className={cn(
				"flex w-full flex-col gap-2",
				inset === "comfortable" && "p-2",
				inset === "panel" && "p-4",
				inset === "detail" && "p-5",
				inset === "catalog" && "p-8",
				inset === "workflow-row" && "px-2",
				inset === "panel-horizontal" && "px-3",
				inset === "navigation" && "pl-8",
				spacing === "compact-panel" && "px-3 py-2",
				spacing === "comfortable" && "py-2",
				spacing === "panel" && "px-3",
				spacing === "budget" && "px-3.5",
				spacing === "spacious" && "py-4",
				spacing === "generous" && "py-6",
				spacing === "review" && "py-16",
				spacing === "library" && "p-6",
				spacing === "tight" && "py-1",
				spacing === "compact-stack" && "py-3",
				spacing === "section" && "py-8",
				spacing === "expanded" && "py-10",
				spacing === "status" && "py-12",
				className
			)}
			data-slot="skeleton-rows"
			role="status"
		>
			<span className="sr-only">{label}</span>
			{ROW_KEYS.slice(0, count).map((key, index) => (
				<Skeleton
					className={cn(
						size === "sm" ? "h-4" : "h-9",
						index === count - 1 && "w-2/3"
					)}
					key={key}
					radius={size === "sm" ? "dense" : "row"}
				/>
			))}
		</div>
	);
}

export { Skeleton, SkeletonRows };
