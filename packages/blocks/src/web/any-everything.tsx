import { cn } from "@ryu/ui/lib/utils";
import { landingSurfaceCardXlClass } from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionHeading } from "./sections.tsx";

const items = [
	{ label: "Any model", sub: "OpenAI, Claude, Gemini, Llama, or local." },
	{ label: "Any provider", sub: "Hosted, OpenRouter, or bring your own key." },
	{ label: "Any agent", sub: "Claude Code, Codex, Pi, or one you built." },
	{ label: "Any OS", sub: "macOS, Windows, and Linux." },
	{
		label: "Any integration",
		sub: "250+ tools via MCP, hundreds more via Composio.",
	},
	{ label: "Any language", sub: "Build in whatever your team already uses." },
];

export default function AnyEverything() {
	return (
		<section className="container mx-auto px-4 py-16 md:py-24">
			<div className="mx-auto max-w-6xl">
				<SectionHeading
					eyebrow="Zero lock-in"
					subtitle="Every layer is swappable. Never locked to one model or vendor."
					title="Works with everything. Locked to nothing."
				/>
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{items.map((item, i) => (
						<Reveal delay={(i % 3) * 0.08} key={item.label}>
							<div className={cn(landingSurfaceCardXlClass, "h-full")}>
								<h3 className="font-medium text-foreground text-lg">
									{item.label}
								</h3>
								<p className="mt-1 text-muted-foreground text-sm leading-relaxed">
									{item.sub}
								</p>
							</div>
						</Reveal>
					))}
				</div>
			</div>
		</section>
	);
}
