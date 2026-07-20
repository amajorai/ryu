"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import Link from "next/link";
import { DownloadMenu } from "./download-menu.tsx";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { SectionTitle } from "./section-title.tsx";

export default function CtaSection() {
	return (
		<section className="container mx-auto px-4 py-24">
			<div className="mx-auto max-w-2xl text-center">
				<SectionTitle title="The new way to build agents." />
				<p className={cn(landingSubheadlineClass, "mx-auto mt-4")}>
					Install Ryu, connect the agents and tools you already run, and keep
					every call governed — budgets, firewall, and audit included.
				</p>
				<div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
					<DownloadMenu />
					<Link
						className={cn(buttonVariants({ variant: "ghost" }))}
						href="https://cal.com/jiaweing/ryu-demo"
						rel="noopener noreferrer"
						target="_blank"
					>
						Book a demo
					</Link>
				</div>
			</div>
		</section>
	);
}
