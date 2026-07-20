import { cn } from "@ryu/ui/lib/utils";
import type { CSSProperties } from "react";
import { landingSurfaceCardXlClass } from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionHeading } from "./sections.tsx";

interface Provider {
	description: string;
	/** Filename under /logos (without extension). */
	logo: string;
	name: string;
	/** True when Ryu routes the CLI's own OAuth session through the gateway. */
	passthrough: boolean;
	/** Plan names the passthrough preserves. */
	plans: string;
	/** Short tag rendered as a pill on the card. */
	tag: string;
}

const PROVIDERS: Provider[] = [
	{
		logo: "claude",
		name: "Claude Code",
		plans: "Claude Pro & Max",
		description:
			"Point Claude Code at the Ryu gateway and it keeps using your own login. Ryu forwards your session untouched and never sets an API key, so you stay on your subscription instead of per-token billing.",
		tag: "Subscription passthrough",
		passthrough: true,
	},
	{
		logo: "openai",
		name: "Codex",
		plans: "ChatGPT Plus, Pro & Business",
		description:
			"Bring the ChatGPT plan you already pay for. Codex authenticates with your own OAuth session while Ryu adds routing, budgets, and usage on top - no OpenAI API key required.",
		tag: "Subscription passthrough",
		passthrough: true,
	},
	{
		logo: "gemini",
		name: "Gemini",
		plans: "Your Google login",
		description:
			"Run the Gemini CLI you are already signed in to. Ryu launches it with your existing Google login intact, ready to work alongside your other agents.",
		tag: "Runs with your login",
		passthrough: false,
	},
];

function maskStyle(logo: string): CSSProperties {
	const url = `url(/logos/${logo}.svg)`;
	return {
		maskImage: url,
		WebkitMaskImage: url,
		maskRepeat: "no-repeat",
		WebkitMaskRepeat: "no-repeat",
		maskPosition: "center",
		WebkitMaskPosition: "center",
		maskSize: "contain",
		WebkitMaskSize: "contain",
	};
}

function ProviderCard({ provider }: { provider: Provider }) {
	return (
		<div className={cn(landingSurfaceCardXlClass, "flex h-full flex-col")}>
			<div className="flex flex-col gap-3">
				<span
					aria-hidden="true"
					className="size-6 shrink-0 bg-foreground/80"
					style={maskStyle(provider.logo)}
				/>
				<div className="flex items-start justify-between gap-3">
					<span className="font-medium text-foreground text-lg">
						{provider.name}
					</span>
					<span
						className={
							provider.passthrough
								? "shrink-0 rounded-full bg-foreground/10 px-2.5 py-1 font-medium text-[11px] text-foreground/70"
								: "shrink-0 rounded-full bg-muted px-2.5 py-1 font-medium text-[11px] text-muted-foreground"
						}
					>
						{provider.tag}
					</span>
				</div>
			</div>
			<p className="mt-1.5 font-medium text-muted-foreground/70 text-xs">
				{provider.plans}
			</p>
			<p className="mt-4 text-muted-foreground text-sm leading-relaxed">
				{provider.description}
			</p>
		</div>
	);
}

export function SubscriptionProvidersGrid() {
	return (
		<>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-3">
				{PROVIDERS.map((provider, i) => (
					<Reveal delay={(i % 3) * 0.08} key={provider.name}>
						<ProviderCard provider={provider} />
					</Reveal>
				))}
			</div>
			<p className="mx-auto mt-8 max-w-2xl text-center text-muted-foreground/70 text-sm leading-relaxed">
				Gateway routing is opt-in per agent, so nothing changes until you turn
				it on. Prefer an API key, OpenRouter, or a local model instead? Those
				all work too.
			</p>
		</>
	);
}

export default function BringYourSubscription() {
	return (
		<section className="container mx-auto px-4 py-16 md:py-24">
			<div className="mx-auto max-w-6xl">
				<SectionHeading
					eyebrow="Your plan, your login, your bill"
					subtitle="Keep Claude Code and Codex on the plan you already pay for."
					title="Bring the subscription you already pay for"
				/>
				<SubscriptionProvidersGrid />
			</div>
		</section>
	);
}
