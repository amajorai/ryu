"use client";

import { AppleHelloEffect } from "@ryu/ui/components/apple-hello-effect.tsx";
import {
	Avatar,
	AvatarFallback,
	AvatarImage,
} from "@ryu/ui/components/avatar.tsx";
import { Card } from "@ryu/ui/components/card.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

const STORY_PARAGRAPHS = [
	"We spent three years shipping agents, and kept hitting the same wall. Agents that worked in a demo broke in production.",
	"No observability. No security. Enterprise tools too expensive and too complicated for the teams we worked with.",
	"I built Ryu for normal people so everyone can harness AI agents, not just the people who read and breathe tech every day.",
	"That is why Ryu wraps whatever engine you pick with governance, routing, and audit on the default path, without ripping out Claude Code, Codex, or the subscription you already have.",
	"We use Ryu deeply at A Major every single day. It automates 97% of our busy work and flags critical issues before we have time to manually review everything.",
	"We also use Ryu to build Ryu.",
];

export default function LandingTestimonials() {
	return (
		<section className="container mx-auto px-4">
			<div className="mx-auto max-w-3xl">
				<div className="mb-10 max-w-2xl">
					<SectionTitle title="Built by people who shipped agents in production" />
					<p className={sectionSubtitleClass}>
						Three years of the same infrastructure layers breaking. Then we
						built what was missing.
					</p>
				</div>

				<Card className="rounded-3xl border border-border/60 bg-card p-8 shadow-sm md:p-12">
					<div className="space-y-6 text-base text-foreground/90 leading-relaxed md:text-lg md:leading-relaxed">
						{STORY_PARAGRAPHS.map((paragraph) => (
							<p key={paragraph}>{paragraph}</p>
						))}
					</div>

					<div className="mt-10">
						<AppleHelloEffect className="h-16 text-foreground" />
					</div>

					<div className="mt-12 flex items-center gap-4">
						<Avatar className="size-12 rounded-xl">
							<AvatarImage
								alt="Jia Wei Ng"
								className="rounded-xl object-cover"
								src="/team/jiawei-ng.png"
							/>
							<AvatarFallback className="rounded-xl font-medium text-sm">
								JW
							</AvatarFallback>
						</Avatar>
						<div>
							<p className="font-medium text-foreground">Jia Wei Ng</p>
							<p className="text-muted-foreground text-sm">
								Co-Founder & CEO, A Major
							</p>
						</div>
					</div>
				</Card>
			</div>
		</section>
	);
}
