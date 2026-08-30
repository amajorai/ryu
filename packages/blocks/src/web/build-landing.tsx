"use client";

import { Blocks, Check, Terminal } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { DOCS_URL } from "./data/resources.tsx";
import HeroWorkflowLoop, {
	HeroUseCaseSwitcher,
} from "./hero-workflow-loop.tsx";
import ProductLandingCtas from "./product-landing-ctas.tsx";

function ArrowIcon() {
	return <span aria-hidden="true">↗</span>;
}

function ConsoleCodeVisual() {
	return (
		<div className="overflow-hidden rounded-2xl bg-[#f1f1ef] text-foreground/80 ring-1 ring-black/10">
			<div className="flex items-center gap-1.5 border-black/10 border-b px-4 py-3 text-xs">
				<span className="size-2.5 rounded-full bg-[#ff5f57]" />
				<span className="size-2.5 rounded-full bg-[#febc2e]" />
				<span className="size-2.5 rounded-full bg-[#28c840]" />
				<span className="ml-3 font-mono text-foreground/40">projects/main</span>
				<span className="ml-auto font-mono text-foreground/40">13.14%</span>
			</div>
			<div className="p-4 font-mono text-[11px] leading-relaxed">
				<div className="mb-4 rounded-lg bg-white/65 px-3 py-2 text-[#3155a6]">
					<span className="text-foreground/40">›</span>{" "}
					/make-interfaces-feel-better
				</div>
				<div className="grid grid-cols-[2rem_1fr] gap-x-3 text-foreground/45">
					<span>44</span>
					<span className="text-foreground/80">
						if (!token) return unauthorized();
					</span>
					<span>45</span>
					<span className="bg-[#dcfce7] text-[#166534]">
						&nbsp;&nbsp;const session = await getSession(req);
					</span>
					<span>46</span>
					<span className="bg-[#dcfce7] text-[#166534]">
						&nbsp;&nbsp;req.user = session.user;
					</span>
					<span>47</span>
					<span className="text-foreground/80">return next();</span>
				</div>
				<div className="mt-4 border-black/10 border-t pt-3 text-foreground/50">
					<span className="text-[#b69cff]">◆</span> Thought for 2.5s
				</div>
				<div className="mt-2 flex items-center gap-2 text-foreground/60">
					<span className="text-[#9dbbff]">›</span> read_file src/api/routes.ts
					<span className="ml-auto text-foreground/35">42 lines</span>
				</div>
				<div className="mt-2 flex items-center gap-2 text-foreground/60">
					<span className="text-[#b69cff]">◆</span> Scan route handlers
					<span className="ml-auto text-[#15803d]">[done]</span>
				</div>
			</div>
			<div className="flex items-center gap-2 border-black/10 border-t px-4 py-3 font-mono text-[10px] text-foreground/50">
				<span className="text-[#9dbbff]">›</span>
				<span className="flex-1">Ask Ryu to keep going</span>
				<span>Ryu · approval required</span>
			</div>
		</div>
	);
}

function ConsoleWorkflowShowcase() {
	const [scenarioIndex, setScenarioIndex] = useState(0);

	return (
		<section className="border-black/10 border-t py-20 md:py-28">
			<div className="mx-auto max-w-6xl px-6">
				<div className="mx-auto max-w-2xl text-center">
					<p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.2em]">
						A run in Console
					</p>
					<h2 className="mt-3 text-balance font-medium text-3xl text-foreground tracking-[-0.04em] md:text-5xl">
						See what happens before you hand it off
					</h2>
					<p className="mt-5 text-balance text-base text-muted-foreground leading-relaxed md:text-lg">
						Pick a familiar job and watch Ryu move from request to result. The
						workspace keeps the context, actions, and handoff in view.
					</p>
				</div>

				<div className="mt-10">
					<HeroUseCaseSwitcher
						current={scenarioIndex}
						onPick={setScenarioIndex}
					/>
				</div>

				<div className="relative mt-4 flex min-h-[28rem] items-center justify-center overflow-hidden rounded-2xl bg-muted/30 px-4 py-6 md:min-h-[34rem] md:px-8 md:py-10">
					<HeroWorkflowLoop
						onScenarioChange={setScenarioIndex}
						scenarioIndex={scenarioIndex}
					/>
				</div>
			</div>
		</section>
	);
}

export default function ConsoleLanding() {
	return (
		<main
			className="min-h-screen bg-white text-foreground"
			data-testid="console-landing"
		>
			<section className="mx-auto flex max-w-6xl flex-col items-center px-6 pt-16 pb-24 text-center md:pt-24 md:pb-28">
				<h1 className="mt-0 max-w-4xl text-balance font-medium text-5xl text-foreground leading-[0.98] tracking-[-0.06em] md:text-7xl">
					Your AI, your models, your rules
				</h1>
				<p className="mt-7 max-w-2xl text-balance text-lg text-muted-foreground leading-relaxed md:text-xl">
					Ryu Console is the desktop workspace for power users and admins. Use
					Ryu's AI or bring your own, then configure the server, tools, and
					access your team relies on.
				</p>

				<ProductLandingCtas className="mt-8" />

				<div className="mt-4 flex items-center gap-2 text-muted-foreground text-xs">
					<Terminal className="size-3.5" />
					Managed, local, or bring your own AI
				</div>
			</section>

			<ConsoleWorkflowShowcase />

			<section className="mx-auto grid max-w-6xl items-center gap-12 px-6 py-24 md:grid-cols-[0.75fr_1.25fr] md:py-32">
				<div>
					<Blocks className="size-7 text-foreground" strokeWidth={1.5} />
					<p className="mt-8 font-medium text-muted-foreground text-xs uppercase tracking-[0.2em]">
						Skills
					</p>
					<h2 className="mt-3 text-balance font-medium text-3xl text-foreground tracking-[-0.04em] md:text-5xl">
						Make your setup reusable
					</h2>
					<p className="mt-5 max-w-md text-base text-muted-foreground leading-relaxed">
						Keep the tools and preferences that make a good run work, then hand
						the setup to the next person.
					</p>
					<ul className="mt-8 space-y-4 text-muted-foreground text-sm">
						{[
							"Use local models, Ryu models, or your own provider",
							"Keep tools and approvals close to the work",
							"Capture a workflow and run it again next time",
						].map((item) => (
							<li className="flex items-start gap-3" key={item}>
								<Check className="mt-0.5 size-4 shrink-0 text-foreground/50" />
								<span>{item}</span>
							</li>
						))}
					</ul>
				</div>
				<ConsoleCodeVisual />
			</section>

			<section className="mx-auto max-w-6xl border-black/10 border-t px-6 py-16 text-center text-muted-foreground text-sm">
				<div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
					<Link className="hover:text-foreground" href="/bot">
						Use Ryu Bot <ArrowIcon />
					</Link>
					<Link className="hover:text-foreground" href="/platform">
						Use Ryu Platform <ArrowIcon />
					</Link>
					<a
						className="hover:text-foreground"
						href={DOCS_URL}
						rel="noopener noreferrer"
						target="_blank"
					>
						Read docs <ArrowIcon />
					</a>
				</div>
			</section>
		</main>
	);
}
