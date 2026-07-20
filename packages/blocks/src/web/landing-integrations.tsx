"use client";

import { cn } from "@ryu/ui/lib/utils.ts";
import { landingSubheadlineClass } from "./landing-typography.ts";
import { SectionTitle } from "./section-title.tsx";

// Bundled locally under apps/web/public/logos (originally from svgl.app).
const SVGL = "/logos";

interface Integration {
	logo: string;
	logoDark?: string;
	mono?: boolean;
	name: string;
}

const INTEGRATIONS: Integration[] = [
	{ name: "Slack", logo: `${SVGL}/slack.svg` },
	{ name: "Notion", logo: `${SVGL}/notion.svg` },
	{ name: "Stripe", logo: `${SVGL}/stripe.svg` },
	{
		name: "GitHub",
		logo: `${SVGL}/github_light.svg`,
		logoDark: `${SVGL}/github_dark.svg`,
	},
	{ name: "Google", logo: `${SVGL}/google.svg`, mono: true },
	{ name: "Dropbox", logo: `${SVGL}/dropbox.svg` },
	{ name: "Figma", logo: `${SVGL}/figma.svg` },
	{ name: "Zoom", logo: `${SVGL}/zoom.svg` },
	{ name: "Asana", logo: `${SVGL}/asana-logo.svg` },
	{ name: "Cloudflare", logo: `${SVGL}/cloudflare.svg` },
	{ name: "Linear", logo: `${SVGL}/linear.svg`, mono: true },
	{ name: "Vercel", logo: `${SVGL}/vercel.svg`, mono: true },
];

function IntegrationCell({
	integration,
	className,
}: {
	integration: Integration;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"flex h-24 items-center justify-center gap-2 bg-background transition-colors duration-200 ease-out hover:bg-background/50 sm:h-28 dark:bg-background/50 dark:hover:bg-background/20",
				className
			)}
		>
			{integration.logoDark ? (
				<>
					<img
						alt={integration.name}
						className="h-6 w-auto max-w-[7rem] object-contain sm:h-7 dark:hidden"
						height={28}
						loading="lazy"
						src={integration.logo}
						width={112}
					/>
					<img
						alt=""
						aria-hidden
						className="hidden h-6 w-auto max-w-[7rem] object-contain sm:h-7 dark:block"
						height={28}
						loading="lazy"
						src={integration.logoDark}
						width={112}
					/>
				</>
			) : (
				<img
					alt={integration.name}
					className={cn(
						"h-6 w-auto max-w-[7rem] object-contain sm:h-7",
						integration.mono && "brightness-0 dark:invert"
					)}
					height={28}
					loading="lazy"
					src={integration.logo}
					width={112}
				/>
			)}
		</div>
	);
}

export default function LandingIntegrations() {
	const firstRow = INTEGRATIONS.slice(0, 5);
	const secondRow = INTEGRATIONS.slice(5);

	return (
		<section className="container mx-auto px-4">
			<div className="mx-auto max-w-6xl">
				<div className="overflow-hidden rounded-3xl border border-border/60 bg-muted/20">
					<div className="grid grid-cols-2 sm:grid-cols-5">
						{firstRow.map((integration, index) => (
							<IntegrationCell
								className={cn(
									index > 0 && "border-border/60 border-l",
									index >= 2 && "border-border/60 border-t sm:border-t-0"
								)}
								integration={integration}
								key={integration.name}
							/>
						))}
					</div>

					<div className="border-border/60 border-y bg-muted/30 px-6 py-10 text-center sm:px-10 sm:py-12">
						<SectionTitle
							suffix={
								<span className="text-muted-foreground"> out of the box</span>
							}
							title="900+ integrations"
						/>
						<p className={cn(landingSubheadlineClass, "mx-auto max-w-xl")}>
							GitHub, Slack, Notion, Gmail, Postgres, and hundreds more via MCP
							and Composio, wired in and governed on every call.
						</p>
					</div>

					<div className="grid grid-cols-2 sm:grid-cols-7">
						{secondRow.map((integration, index) => (
							<IntegrationCell
								className={cn(
									index > 0 && "border-border/60 border-l",
									index >= 2 && "border-border/60 border-t sm:border-t-0"
								)}
								integration={integration}
								key={integration.name}
							/>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
