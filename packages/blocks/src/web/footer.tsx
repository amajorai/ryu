"use client";

import Aurora from "./aurora.tsx";
import BackedBy from "./backed-by.tsx";
import FooterBuildInfo from "./footer-build-info.tsx";
import { ThemeToggle } from "./theme-toggle.tsx";

export default function Footer() {
	return (
		<footer className="relative overflow-x-clip pt-16">
			{/* Content - sits above the gradient */}
			<div className="container relative z-10 mx-auto px-4">
				{/* Two column links */}
				<div className="mb-12 grid grid-cols-1 gap-12 md:grid-cols-2">
					<div className="space-y-4">
						<h3 className="font-medium text-2xl">
							End-to-end infrastructure for AI agents
						</h3>
						<p className="max-w-md text-muted-foreground">
							The platform for every agent to collaborate with humans. With
							tools, security, memory, cost saving, and routing all built in.
						</p>
						<BackedBy className="pt-2" />
					</div>

					<div className="grid grid-cols-2 gap-x-8 gap-y-8 sm:grid-cols-3 sm:gap-x-12 lg:gap-x-16">
						<div>
							<h4 className="mb-4 font-semibold">Platform</h4>
							<div className="space-y-2">
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
									href="/products/agents"
								>
									Agents
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products/workflows"
								>
									Workflows
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/subscriptions"
								>
									Bring your subscription
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/products"
								>
									All products
								</a>
							</div>
						</div>

						<div>
							<h4 className="mb-4 font-semibold">Developers</h4>
							<div className="space-y-2">
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
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/marketplace"
								>
									Customize
								</a>
							</div>
						</div>

						<div>
							<h4 className="mb-4 font-semibold">Company</h4>
							<div className="space-y-2">
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/for/agent-operators"
								>
									Agent operators
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/startups"
								>
									Startups
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
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/compare"
								>
									Compare
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/changelog"
								>
									Changelog
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="/help"
								>
									Help
								</a>
								<a
									className="block text-muted-foreground transition-colors hover:text-foreground"
									href="https://discord.gg/46FkCKCMba"
									rel="noopener noreferrer"
									target="_blank"
								>
									Discord
								</a>
							</div>
						</div>
					</div>
				</div>

				{/* Horizontal links + copyright */}
				<div className="mt-32 space-y-4 text-center">
					<FooterBuildInfo />
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
						© {new Date().getFullYear()}{" "}
						<span itemProp="name">A Major Pte. Ltd.</span>,{" "}
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

			{/* Giant ryu — bottom ~25% clipped; ~3/4 of the wordmark visible */}
			<div className="relative z-10 -mt-6 flex h-[clamp(4rem,34vw,22.5rem)] items-start justify-center overflow-hidden">
				<div
					aria-hidden="true"
					className="select-none font-black text-foreground/10 leading-none"
					style={{ fontSize: "clamp(5rem,45vw,30rem)" }}
				>
					ryu
				</div>
			</div>
		</footer>
	);
}
