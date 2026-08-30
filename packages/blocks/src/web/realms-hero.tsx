"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import { ChromaticTextReveal } from "@ryu/ui/components/motion/chromatic-text-reveal";
import PageHeader from "@ryu/ui/components/page-header";
import { cn } from "@ryu/ui/lib/utils";
import {
	ChevronRight,
	Cloud,
	LockKeyhole,
	Plug,
	Timer,
	Workflow,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DOCS_URL } from "./data/resources.tsx";
import { DownloadMenu } from "./download-menu.tsx";
import {
	InstallLocalMock,
	SevenMinuteMock,
	StillRunningMock,
	TrustReceiptMock,
} from "./emotional-story-mockups.tsx";
import HeroWorkflowLoop, {
	HeroUseCaseSwitcher,
} from "./hero-workflow-loop.tsx";
import { landingHeadlineClass } from "./landing-typography.ts";
import ProductLandingCtas from "./product-landing-ctas.tsx";
import { ProductRealmSelector } from "./product-realm-selector.tsx";
import {
	BentoGrid,
	type BentoItem,
	SectionTitle,
	sectionSubtitleClass,
} from "./sections.tsx";
import { StaggerLines } from "./stagger-lines.tsx";
import { StandaloneServicesSection } from "./standalone-services-section.tsx";
import StartupPrograms from "./startup-programs.tsx";

const MANAGED_DEPLOYMENT_STEPS = [
	{
		description: "We put the agent and its approved tools in the cloud.",
		icon: Cloud,
		label: "Deploy",
		status: "Configured",
	},
	{
		description:
			"We watch the run, handle the upkeep, and keep the workflow available.",
		icon: Timer,
		label: "Operate",
		status: "Maintained",
	},
	{
		description:
			"Your team sees the result, the access, and the record of what happened.",
		icon: LockKeyhole,
		label: "Stay in control",
		status: "Governed",
	},
] as const;

const INTEGRATION_BENTO_ITEMS: BentoItem[] = [
	{
		description: "Bring the models and provider access you already use.",
		title: "Use existing AI",
		visual: <InstallLocalMock />,
	},
	{
		description: "Connect approved files and systems to the work.",
		span: "md:col-span-2",
		title: "Connect your tools",
		visual: <SevenMinuteMock />,
	},
	{
		description: "Keep approvals, audit, and cost with the result.",
		span: "md:col-span-2",
		title: "Secure each run",
		visual: <TrustReceiptMock />,
	},
	{
		description: "Ryu deploys the runtime and keeps it running.",
		title: "Deploy to Cloud",
		visual: <StillRunningMock />,
	},
];

function LandingSectionHeader({
	className,
	subtitle,
	title,
}: {
	className?: string;
	subtitle: string;
	title: string;
}) {
	return (
		<StaggerLines className={cn("max-w-2xl", className)}>
			<SectionTitle title={title} />
			<p className={sectionSubtitleClass}>{subtitle}</p>
		</StaggerLines>
	);
}

function ManagedDeployment() {
	return (
		<section
			className="bg-muted/20"
			data-testid="managed-deployment"
			id="managed-deployment"
		>
			<div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
				<div className="grid gap-10 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] lg:items-center lg:gap-16">
					<div className="max-w-xl">
						<LandingSectionHeader
							className="max-w-xl"
							subtitle="Ryu is the integration layer for AI. We deploy the runtime, keep it running, and give you one place to use and oversee it."
							title="We deploy and keep it running."
						/>
						<Link
							className="mt-6 inline-flex items-center gap-2 font-medium text-foreground text-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							href="/console"
						>
							See the control surface
							<ChevronRight aria-hidden="true" className="size-4" />
						</Link>
					</div>

					<div className="rounded-[2rem] bg-background p-5 shadow-[0_24px_70px_-48px_rgba(15,23,42,0.55)] ring-1 ring-black/[0.06] sm:p-7 dark:ring-white/[0.08]">
						<div className="flex items-center justify-between gap-4 pb-4">
							<div>
								<p className="font-medium text-foreground text-sm">
									What Ryu handles
								</p>
								<p className="mt-1 text-muted-foreground text-xs">
									The work between your idea and a dependable run.
								</p>
							</div>
							<span className="rounded-full bg-muted px-2.5 py-1 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
								Cloud
							</span>
						</div>

						<ol className="mt-6 space-y-5">
							{MANAGED_DEPLOYMENT_STEPS.map((step) => {
								const Icon = step.icon;
								return (
									<li className="relative flex gap-3.5" key={step.label}>
										<span className="relative z-10 flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground/65">
											<Icon aria-hidden="true" className="size-4" />
										</span>
										<span className="min-w-0 flex-1 pt-0.5">
											<span className="flex flex-wrap items-center justify-between gap-2">
												<span className="font-medium text-foreground text-sm">
													{step.label}
												</span>
												<span className="text-[10px] text-muted-foreground uppercase tracking-wider">
													{step.status}
												</span>
											</span>
											<span className="mt-1 block text-muted-foreground text-sm leading-relaxed">
												{step.description}
											</span>
										</span>
									</li>
								);
							})}
						</ol>
					</div>
				</div>
			</div>
		</section>
	);
}

export default function RealmsHero() {
	const [scenarioIndex, setScenarioIndex] = useState(0);

	return (
		<main className="bg-background text-foreground" data-testid="realms-hero">
			<section className="mx-auto max-w-6xl px-6 pt-16 pb-20 md:pt-24 md:pb-24">
				<div className="max-w-2xl">
					<PageHeader
						className="max-w-xl"
						title={
							<>
								We deploy and run AI agents
								<br />
								<ChromaticTextReveal
									delay={0.3}
									loop={false}
									once
									prefix="safely in the"
									startOnView
									words={["cloud"]}
								/>
							</>
						}
						titleClassName={landingHeadlineClass}
					/>

					<div className="mt-8 flex flex-col gap-3 sm:flex-row">
						<DownloadMenu
							label="Download"
							separatorClassName="bg-primary-foreground/10 data-vertical:mx-0"
							size="default"
						/>
						<a
							className={cn(
								buttonVariants({ variant: "ghost" }),
								"rounded-full"
							)}
							href={DOCS_URL}
							rel="noopener noreferrer"
							target="_blank"
						>
							Documentation
						</a>
					</div>
				</div>

				<div className="mx-auto mt-16 max-w-5xl">
					<HeroUseCaseSwitcher
						current={scenarioIndex}
						onPick={setScenarioIndex}
					/>
					<div className="relative mt-4 flex min-h-[28rem] items-center justify-center overflow-hidden rounded-2xl px-4 py-6 md:min-h-[34rem] md:px-8 md:py-10">
						<div
							aria-hidden="true"
							className="pointer-events-none absolute inset-0 bg-[url('/background.png')] bg-center bg-cover opacity-80"
						/>
						<div className="relative z-10 w-full max-w-6xl py-4 md:py-6">
							<HeroWorkflowLoop
								onScenarioChange={setScenarioIndex}
								scenarioIndex={scenarioIndex}
							/>
						</div>
					</div>
				</div>

				<div className="mx-auto mt-12 max-w-5xl">
					<ProductRealmSelector />
				</div>

				<div className="mt-14 grid gap-3 pt-6 text-sm sm:grid-cols-3">
					<div className="flex gap-3">
						<Workflow
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-emerald-600"
						/>
						<div>
							<p className="font-medium text-foreground/80">
								Useful on day one
							</p>
							<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
								Start from a process you already run.
							</p>
						</div>
					</div>
					<div className="flex gap-3">
						<Timer
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-[#8f7bf2]"
						/>
						<div>
							<p className="font-medium text-foreground/80">
								Live in a few minutes
							</p>
							<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
								Start from the job you need done, not a blank repo or an
								infrastructure project.
							</p>
						</div>
					</div>
					<div className="flex gap-3">
						<Cloud
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-[#d97706]"
						/>
						<div>
							<p className="font-medium text-foreground/80">
								Managed in the cloud
							</p>
							<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
								We deploy and keep it running, with permissions and audit
								history in place.
							</p>
						</div>
					</div>
				</div>
			</section>

			<section className="bg-muted/20" id="how-it-works">
				<div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
					<LandingSectionHeader
						subtitle="Tell Ryu the job you need done. Ryu connects the tools you already use, then runs the workflow in the cloud without another platform to build."
						title="Start a working deployment in a few minutes."
					/>

					<div className="mt-12 grid gap-3 md:grid-cols-3">
						<div className="rounded-2xl bg-background p-5 ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
							<Workflow
								aria-hidden="true"
								className="size-5 text-foreground/70"
							/>
							<h3 className="mt-7 font-medium text-foreground text-lg tracking-tight">
								Choose one job
							</h3>
							<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
								Start with a repeatable task your team needs done every week.
							</p>
						</div>
						<div className="rounded-2xl bg-background p-5 ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
							<Plug aria-hidden="true" className="size-5 text-foreground/70" />
							<h3 className="mt-7 font-medium text-foreground text-lg tracking-tight">
								Connect your tools
							</h3>
							<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
								Use the systems your team already relies on, with only the
								access the run needs.
							</p>
						</div>
						<div className="rounded-2xl bg-background p-5 ring-1 ring-black/[0.06] dark:ring-white/[0.08]">
							<Cloud aria-hidden="true" className="size-5 text-foreground/70" />
							<h3 className="mt-7 font-medium text-foreground text-lg tracking-tight">
								We keep it running
							</h3>
							<p className="mt-2 text-muted-foreground text-sm leading-relaxed">
								Ryu deploys the workflow, handles the upkeep, and keeps the run
								governed.
							</p>
						</div>
					</div>
				</div>
			</section>

			<section className="mx-auto max-w-6xl px-6 py-20 md:py-28">
				<div className="grid items-center gap-8 rounded-[2rem] bg-[#16151a] px-6 py-8 text-white md:grid-cols-[1fr_auto] md:px-10 md:py-10">
					<div>
						<h2 className="max-w-2xl text-balance font-medium text-xl leading-tight tracking-tight md:text-2xl">
							Ryu runs the AI layer.
						</h2>
						<p className="mt-3 max-w-xl font-medium text-white/60 text-xl leading-tight tracking-tight md:text-2xl">
							Use the apps, tools, models, and workflows you already have
							without building and maintaining another runtime.
						</p>
					</div>
					<div className="md:min-w-52 md:text-right">
						<p className="font-medium text-2xl tracking-[-0.04em]">
							A few minutes
						</p>
						<p className="mt-1 text-sm text-white/55">
							to get your first workflow running
						</p>
						<Link
							className={cn(
								buttonVariants({ variant: "secondary" }),
								"mt-5 rounded-full bg-white text-[#16151a] hover:bg-white/90"
							)}
							href="/pricing"
						>
							View plans
						</Link>
					</div>
				</div>
			</section>

			<section id="integration-layer">
				<div className="mx-auto max-w-6xl px-6 py-20 md:py-28">
					<LandingSectionHeader
						subtitle="Ryu connects existing apps, tools, models, and workflows through one composable integration layer."
						title="Connect the pieces. Run the work."
					/>
					<div className="mt-12">
						<BentoGrid items={INTEGRATION_BENTO_ITEMS} />
					</div>
				</div>
			</section>

			<ManagedDeployment />
			<StandaloneServicesSection />

			<section>
				<div className="mx-auto flex max-w-6xl flex-col items-center px-6 py-20 text-center md:py-28">
					<p className="max-w-2xl text-balance font-medium text-3xl text-foreground leading-tight tracking-[-0.04em] md:text-5xl">
						Run autonomous AI in the cloud.
					</p>
					<ProductLandingCtas className="mt-8" />
				</div>
			</section>
			<StartupPrograms />
		</main>
	);
}
