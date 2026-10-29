import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";

const sectionTitleSizes = {
	default: "text-3xl md:text-4xl lg:text-[2.75rem]",
	large: "text-4xl md:text-5xl lg:text-[3.5rem]",
	small: "text-xl md:text-2xl",
	compact: "text-lg md:text-xl",
} as const;

export type SectionTitleSize = keyof typeof sectionTitleSizes;

export const sectionTitleClass =
	"text-balance font-heading font-medium text-3xl text-foreground leading-[1.1] tracking-[-0.03em] md:text-4xl lg:text-[2.75rem]";

interface SectionTitleProps {
	as?: "h1" | "h2";
	className?: string;
	colors?: string[];
	delay?: number;
	duration?: number;
	size?: SectionTitleSize;
	suffix?: ReactNode;
	title: string;
}

export function SectionTitle({
	title,
	suffix,
	as: Tag = "h2",
	size = "default",
	className,
}: SectionTitleProps) {
	return (
		<Tag
			className={cn(
				"text-balance font-heading font-medium text-foreground leading-[1.1] tracking-[-0.03em]",
				sectionTitleSizes[size],
				className
			)}
		>
			{title}
			{suffix}
		</Tag>
	);
}
