"use client";

import { cn } from "@ryu/ui/lib/utils";
import { useInView } from "motion/react";
import { useRef } from "react";
import { landingHeadlineClass } from "./landing-typography.ts";

/** The download page's staggered heading. It observes its own visibility, so it
 *  lives in a client module: `download.tsx` is also imported by server code for
 *  its release constants and must stay free of hooks. */
export function DownloadHero() {
	const ref = useRef<HTMLDivElement>(null);
	const shown = useInView(ref, { once: true });
	return (
		<div
			className={cn(
				"t-stagger mx-auto max-w-3xl space-y-1 text-center",
				shown && "is-shown"
			)}
			ref={ref}
		>
			<h1
				className={cn("t-stagger-line t-stagger-line--1", landingHeadlineClass)}
			>
				Your agents are ready
			</h1>
		</div>
	);
}
