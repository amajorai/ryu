"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import PageHeader from "@ryu/ui/components/page-header";
import { StaggerReveal } from "@ryu/ui/components/stagger-reveal";
import { cn } from "@ryu/ui/lib/utils";
import { Library } from "lucide-react";
import Link from "next/link";
import AppShowcase from "./app-showcase.tsx";
import { HeroAvatarSocialProof } from "./c-avatar-20.tsx";
import { DownloadMenu } from "./download-menu.tsx";
import { landingHeadlineClass } from "./landing-typography.ts";

const DECOSMIC_HREF = "https://decosmic.com";
const AMAJOR_HREF = "https://amajor.ai";

const DEMO_HREF = "https://cal.com/jiaweing/ryu-demo";

const HERO_TITLE =
	"We help companies save time and money\nwith AI agents that do real work.";

export default function Hero() {
	return (
		<div className="flex flex-col items-center gap-8 pt-14 pb-0 md:pt-20">
			<div className="flex min-h-[80vh] w-screen flex-col px-4 md:flex md:items-center md:justify-center md:px-0">
				<div className="mx-auto w-full max-w-6xl px-4 py-8 md:py-12">
					<div className="space-y-8">
						<StaggerReveal>
							<p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-muted-foreground text-xs tracking-tight md:text-sm">
								From the team behind{" "}
								<a
									className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 transition-colors hover:text-foreground/80 hover:underline"
									href={DECOSMIC_HREF}
									rel="noopener noreferrer"
									target="_blank"
								>
									<span className="inline-flex size-4 shrink-0 items-center justify-center rounded-[5px] bg-[#0099ff] text-white">
										<Library
											aria-hidden="true"
											className="size-2.5"
											strokeWidth={2.25}
										/>
									</span>
									Decosmic
								</a>
								<span aria-hidden="true">&</span>
								<a
									className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 transition-colors hover:text-foreground/80 hover:underline"
									href={AMAJOR_HREF}
									rel="noopener noreferrer"
									target="_blank"
								>
									<img
										alt=""
										className="size-4 shrink-0 rounded-[5px] object-cover"
										src="/logos/amajor.png"
									/>
									A Major
								</a>
							</p>

							<PageHeader
								className="max-w-2xl whitespace-pre-line"
								title={HERO_TITLE}
								titleClassName={landingHeadlineClass}
							/>

							<div className="flex flex-col gap-3 sm:flex-row">
								<DownloadMenu />
								<Link
									className={cn(buttonVariants({ variant: "ghost" }))}
									href={DEMO_HREF}
									rel="noopener noreferrer"
									target="_blank"
								>
									Book a demo
								</Link>
							</div>

							<HeroAvatarSocialProof />
						</StaggerReveal>
					</div>
				</div>

				{/* The real desktop app + floating Island, interactive */}
				<div className="relative z-0 w-full px-4 py-6 md:px-8 md:py-8">
					<div className="relative mx-auto flex min-h-[28rem] w-full max-w-7xl items-center justify-center md:min-h-[34rem]">
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl bg-[url('/background.png')] bg-center bg-cover opacity-80"
						/>
						<div className="relative z-10 w-full max-w-6xl py-4 md:py-6">
							<AppShowcase />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
