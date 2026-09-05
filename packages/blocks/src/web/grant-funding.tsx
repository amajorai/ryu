import { buttonVariants } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";
import { ArrowUpRight, Landmark } from "lucide-react";
import Link from "next/link";
import { DEMO_HREF } from "./data/resources.tsx";
import { landingSurfaceCardXlClass } from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";

/**
 * Co-funding is the closing lever for a Singapore SME, so it belongs early in
 * the conversation rather than buried in a sales deck.
 *
 * What this section deliberately does NOT do is print a support percentage.
 * A figure next to a scheme name reads as "Ryu is claimable under it", and
 * eligibility of a given solution and a given company is the agency's call,
 * not ours. On a page whose whole pitch is "we can prove what happened", an
 * implied claim we cannot back costs more than it earns. Print percentages
 * here only once we can point at our own listing.
 */
const SCHEMES: { body: string; href: string; name: string }[] = [
	{
		name: "Productivity Solutions Grant",
		body: "Support for SMEs adopting digital solutions from the pre-approved list, administered through GoBusiness.",
		href: "https://www.gobusiness.gov.sg/productivity-solutions-grant/",
	},
	{
		name: "Enterprise Development Grant",
		body: "Support for projects that upgrade how the business runs, including new systems and processes.",
		href: "https://www.enterprisesg.gov.sg/financial-support/enterprise-development-grant",
	},
];

export default function GrantFunding() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<StaggerLines className="max-w-2xl">
					<SectionTitle title="You may not be paying for all of it." />
					<p className={sectionSubtitleClass}>
						Singapore runs co-funding schemes for exactly this kind of
						deployment. We will tell you straight what your firm can and cannot
						claim.
					</p>
				</StaggerLines>

				<div className="mt-14 grid gap-3 md:grid-cols-2">
					{SCHEMES.map((scheme, i) => (
						<Reveal delay={(i % 2) * 0.08} key={scheme.name}>
							<a
								className={cn(
									landingSurfaceCardXlClass,
									"group block h-full no-underline"
								)}
								href={scheme.href}
								rel="noopener noreferrer"
								target="_blank"
							>
								<Landmark
									aria-hidden="true"
									className="size-5 text-foreground"
									strokeWidth={1.75}
								/>
								<h3 className="mt-6 inline-flex items-center gap-1 font-medium text-base text-foreground">
									{scheme.name}
									<ArrowUpRight
										aria-hidden="true"
										className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
									/>
								</h3>
								<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
									{scheme.body}
								</p>
							</a>
						</Reveal>
					))}
				</div>

				<p className="mt-6 max-w-2xl text-muted-foreground/70 text-xs leading-relaxed">
					Support levels, caps and eligibility are set by the administering
					agency, differ per company and change over time. Nothing here is a
					promise that a particular deployment qualifies. Bring it up on the
					call and we will go through what applies to you.
				</p>

				<div className="mt-8">
					<Link
						className={cn(buttonVariants({ variant: "default" }))}
						href={DEMO_HREF}
						rel="noopener noreferrer"
						target="_blank"
					>
						Talk through funding
					</Link>
				</div>
			</div>
		</section>
	);
}
