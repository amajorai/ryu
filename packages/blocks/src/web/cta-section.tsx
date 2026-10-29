"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { DEMO_HREF } from "./data/resources.tsx";
import { DownloadMenu } from "./download-menu.tsx";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { SectionTitle } from "./section-title.tsx";
import { StaggerLines } from "./stagger-lines.tsx";

/**
 * Six other pages close with this block (`/products`, `/compare`, `/for`,
 * `/benchmark`, `/subscriptions`, `/community`), so the DEFAULT copy has to
 * read correctly on all of them. The landing page's own pitch — the paperwork,
 * the funding — is passed in as props rather than baked in here, or it leaks
 * onto pages where it makes no sense.
 */
export default function CtaSection({
	primaryHref = DEMO_HREF,
	primaryLabel = "Talk to the team",
	title = "Try Ryu with your team",
	subtitle = "Tell us what you want to automate. We can help you choose a setup and connect your tools.",
}: {
	primaryHref?: string;
	primaryLabel?: string;
	subtitle?: string;
	title?: string;
} = {}) {
	return (
		<section className="container mx-auto px-4 py-24">
			<div className="max-w-2xl">
				{/* Wraps only the title and its supporting line: the button row below is
				    a flex layout and `.t-stagger-line` would force it to block. */}
				<StaggerLines>
					<SectionTitle title={title} />
					<p className={cn(landingSubheadlineClass, "mx-auto mt-4")}>
						{subtitle}
					</p>
				</StaggerLines>
				<div className="mt-8 flex flex-wrap items-center gap-3">
					<a
						className={cn(buttonVariants({ variant: "mono" }))}
						href={primaryHref}
						rel={
							primaryHref.startsWith("http") ? "noopener noreferrer" : undefined
						}
						target={primaryHref.startsWith("http") ? "_blank" : undefined}
					>
						{primaryLabel}
					</a>
					<DownloadMenu variant="ghost" />
				</div>
			</div>
		</section>
	);
}
