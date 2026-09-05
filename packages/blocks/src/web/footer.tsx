"use client";

import { Logo } from "@ryu/ui/components/logo.tsx";

import Aurora from "./aurora.tsx";
import BackedBy from "./backed-by.tsx";
import FooterBuildInfo from "./footer-build-info.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";
import "./footer.css";

// Cache Components requires client prerenders to be deterministic.
const COPYRIGHT_YEAR = 2026;

export default function Footer({
	githubStargazersCount,
}: {
	githubStargazersCount?: number | null;
}) {
	return (
		<footer className="relative overflow-x-clip pt-16">
			{/* Content sits above the Aurora and outline mark and stays on shared surfaces. */}
			<div className="container relative z-10 mx-auto px-4">
				{/* Two column links */}
				<div className="mb-12 grid grid-cols-1 gap-12 md:grid-cols-2">
					<div className="space-y-4">
						<h3 className="font-medium text-2xl">
							The universal AI integration layer
						</h3>
						<p className="max-w-md text-muted-foreground">
							We deploy and keep your agents running for you. Connect the tools
							it needs and integrate where you want it to run.
						</p>
						<BackedBy className="pt-2" />
					</div>

					<div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 sm:gap-x-12 lg:gap-x-16">
						<div>
							<h4 className="mb-4 font-medium">Platform</h4>
							<div className="space-y-2">
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/sdk"
								>
									SDK
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/core"
								>
									Core
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/gateway"
								>
									Gateway
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/marketplace/apps"
								>
									Ryu Apps
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/platform#infra"
								>
									Ryu Infra
								</a>
							</div>
						</div>

						<div>
							<h4 className="mb-4 font-medium">Learn</h4>
							<div className="space-y-2">
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/academy"
								>
									Academy
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/certifications"
								>
									Certifications
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/cli"
								>
									CLI
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/sdk"
								>
									SDK
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/mcp"
								>
									MCP
								</a>
							</div>
						</div>

						<div>
							<h4 className="mb-4 font-medium">Company</h4>
							<div className="space-y-2">
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/for/agent-operators"
								>
									AI operators
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/startups"
								>
									Programs
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/partners"
								>
									Partners
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/perks"
								>
									Perks
								</a>
							</div>
						</div>
					</div>
				</div>

				{/* Horizontal links + copyright */}
				<div className="mt-32 space-y-4 text-center">
					<FooterBuildInfo githubStargazersCount={githubStargazersCount} />
					<div className="flex items-center justify-center gap-8 text-muted-foreground text-sm">
						<ThemeToggle />
						<a
							className="transition-colors hover:text-foreground"
							href="/privacy"
						>
							Privacy
						</a>
						<a
							className="transition-colors hover:text-foreground"
							href="/terms"
						>
							Terms
						</a>
						<a
							className="transition-colors hover:text-foreground"
							href="/contact"
						>
							Contact
						</a>
						<a className="transition-colors hover:text-foreground" href="/dpa">
							<span className="hidden lg:block">Data Processing Agreement</span>
							<span className="block lg:hidden">DPA</span>
						</a>
					</div>

					<p
						className="pb-20 text-muted-foreground text-sm"
						itemScope
						itemType="https://schema.org/Organization"
					>
						© {COPYRIGHT_YEAR} <span itemProp="name">A Major Pte. Ltd.</span>,{" "}
						<span itemProp="location">Singapore</span>. <br />
						(UEN: <span itemProp="taxID">202616096G</span>)
						<meta content="2026-04-12" itemProp="foundingDate" />
						<meta content="https://amajor.ai" itemProp="url" />
						<meta
							content="A Major is a Singapore-based software agency specialising in web design, software development, and digital solutions for businesses."
							itemProp="description"
						/>
					</p>
				</div>
			</div>

			<div
				aria-hidden="true"
				className="pointer-events-none absolute inset-x-0 bottom-0 z-0 h-[38rem] [mask-image:linear-gradient(to_top,black_72%,transparent)]"
			>
				<Aurora amplitude={0.2} blend={0.65} fan={0.65} speed={2.5} />
			</div>

			{/* Giant Ryu outline — only the top half rises into view; the eyes track the cursor. */}
			<div className="relative z-10 -mt-6 flex h-[clamp(10rem,20vw,16rem)] -translate-y-20 items-start justify-center overflow-hidden sm:translate-y-0">
				<div
					aria-hidden="true"
					className="pointer-events-none origin-top -translate-x-16 scale-90 select-none text-foreground/15 sm:scale-110 md:scale-125 lg:scale-150"
					data-testid="footer-ryu-logo"
				>
					<Logo
						animated
						className="footer-ryu-logo__mark"
						size="360px"
						variant="outline"
					/>
				</div>
			</div>
		</footer>
	);
}
