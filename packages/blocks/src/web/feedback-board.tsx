"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { SectionTitle } from "./section-title.tsx";

const USERJOT_BOARD_URL = "https://ryuhq.userjot.com/";

export default function FeedbackBoard() {
	return (
		<section className="container mx-auto px-4 py-16 md:py-20">
			<div className="mx-auto max-w-2xl rounded-3xl border border-border/60 bg-muted/30 p-8 text-center md:p-12">
				<SectionTitle title="Need something added? Want a feature?" />
				<p className={cn(landingSubheadlineClass, "mx-auto mt-4 max-w-lg")}>
					Request what you need, vote on ideas from other teams, and follow what
					we ship on our public roadmap.
				</p>
				<Link
					className={cn(buttonVariants({ variant: "outline" }), "mt-8")}
					href={USERJOT_BOARD_URL}
					rel="noopener noreferrer"
					target="_blank"
				>
					Open UserJot
				</Link>
			</div>
		</section>
	);
}
