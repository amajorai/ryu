import { cn } from "@ryu/ui/lib/utils";
import { ArrowRight } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { solutions } from "./data/solutions.ts";
import { Reveal } from "./reveal.tsx";
import { iconFor } from "./solutions-sections.tsx";

// A compact "pick your role" cloud for the landing page: every role as a pill
// linking to its /for/<slug> page. Showcases breadth without a full grid.
export function RolesOverview() {
	return (
		<div className="space-y-8">
			<div className="flex flex-wrap justify-center gap-2.5">
				{solutions.map((s, i) => {
					const Icon = iconFor(s.icon);
					return (
						<Reveal delay={(i % 6) * 0.03} key={s.slug}>
							<Link
								className={cn(
									"group inline-flex items-center gap-2 rounded-full border border-border/60 bg-muted/40 px-4 py-2 font-medium text-foreground/80 text-sm backdrop-blur-sm transition-colors duration-200 hover:bg-muted/70 hover:text-foreground"
								)}
								href={`/for/${s.slug}` as Route}
							>
								<Icon
									className="size-4 text-foreground/60 transition-colors group-hover:text-foreground"
									strokeWidth={1.5}
								/>
								{s.name}
							</Link>
						</Reveal>
					);
				})}
			</div>
			<div className="flex justify-center">
				<Link
					className="inline-flex items-center gap-1.5 font-medium text-muted-foreground text-sm transition-colors hover:text-foreground"
					href="/for"
				>
					See every role
					<ArrowRight className="size-4" />
				</Link>
			</div>
		</div>
	);
}
