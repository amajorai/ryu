"use client";

import {
	DiaText,
	type DiaTextRevealProps,
} from "@ryu/ui/components/dia-text.tsx";
import { cn } from "@ryu/ui/lib/utils.ts";
import type { ReactNode } from "react";
import { landingHeadlineClass } from "./landing-typography.ts";

const sectionTitleSizes = {
	default: landingHeadlineClass,
	large: landingHeadlineClass,
	small: landingHeadlineClass,
	compact: landingHeadlineClass,
} as const;

export type SectionTitleSize = keyof typeof sectionTitleSizes;

export const sectionTitleClass = sectionTitleSizes.default;

type SectionTitleProps = {
	title: string;
	suffix?: ReactNode;
	as?: "h1" | "h2";
	size?: SectionTitleSize;
	className?: string;
} & Pick<DiaTextRevealProps, "colors" | "delay" | "duration">;

export function SectionTitle({
	title,
	suffix,
	as: Tag = "h2",
	size = "default",
	className,
	colors,
	delay = 0,
	duration = 1.35,
}: SectionTitleProps) {
	return (
		<Tag className={cn(sectionTitleSizes[size], className)}>
			<DiaText
				colors={colors}
				delay={delay}
				duration={duration}
				once
				text={title}
				textColor="currentColor"
				triggerOnView
			/>
			{suffix}
		</Tag>
	);
}
