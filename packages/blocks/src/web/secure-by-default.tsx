import { cn } from "@ryu/ui/lib/utils";
import { AlertTriangle, BadgeCheck, Check, ShieldCheck, X } from "lucide-react";
import { GatewayMock } from "./gateway-showcase.tsx";
import {
	LANDING_CARD_TONES,
	landingCardSurfaceClass,
	landingMutedCardSurfaceClass,
} from "./landing-card-tones.ts";
import { Reveal } from "./reveal.tsx";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

/**
 * "Secure by default" — the risk contrast. DIY agent setups (especially local
 * AI) are one misconfiguration away from an incident. Styled like the rest of
 * the landing page (SaveTimeMoney cards: muted surfaces, monochrome icons).
 */

const RISKS = [
	"API keys sit in plaintext .env files and shell history",
	"Tools run with full disk and network access, no allowlist",
	"A scraped page hides a prompt injection that runs unchecked",
	"Your local model quietly phones home with no egress control",
	"No budget cap, so a runaway loop bills you overnight",
	"Nothing is logged, so you can't tell what went wrong",
] as const;

const DEFENSES = [
	"Keys encrypted at rest, never written to logs or plaintext",
	"Every tool call is allowlisted and sandboxed before it runs",
	"Firewall blocks prompt injection and data exfiltration",
	"PII / DLP redaction before anything leaves your machine",
	"Hard budget caps and rate limits on every agent",
	"Full audit trail of every model call and tool run",
] as const;

function RiskCard() {
	return (
		<div className={landingMutedCardSurfaceClass}>
			<AlertTriangle className="size-5 text-foreground" strokeWidth={1.75} />
			<p className="mt-6 font-semibold text-muted-foreground/60 text-xs uppercase tracking-widest">
				On your own
			</p>
			<h3 className="mt-2 font-medium text-foreground text-xl tracking-tight md:text-2xl">
				Wiring it up yourself
			</h3>
			<ul className="mt-6 space-y-3">
				{RISKS.map((risk) => (
					<li className="flex items-start gap-3" key={risk}>
						<X
							aria-hidden="true"
							className="mt-0.5 size-4 shrink-0 text-muted-foreground/70"
							strokeWidth={1.5}
						/>
						<span className="text-foreground/80 text-sm leading-relaxed">
							{risk}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function DefenseCard() {
	const tone = LANDING_CARD_TONES.green;
	return (
		<div className={landingCardSurfaceClass("green")}>
			<ShieldCheck className={cn("size-5", tone.title)} strokeWidth={1.75} />
			<p
				className={cn(
					"mt-6 font-semibold text-xs uppercase tracking-widest",
					tone.eyebrow
				)}
			>
				With Ryu
			</p>
			<h3
				className={cn(
					"mt-2 font-medium text-xl tracking-tight md:text-2xl",
					tone.title
				)}
			>
				Secure out of the box
			</h3>
			<ul className="mt-6 space-y-3">
				{DEFENSES.map((defense) => (
					<li className="flex items-start gap-3" key={defense}>
						<Check
							aria-hidden="true"
							className={cn("mt-0.5 size-4 shrink-0", tone.marker)}
							strokeWidth={1.5}
						/>
						<span className={cn("text-sm leading-relaxed", tone.bullet)}>
							{defense}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

export default function SecureByDefault() {
	return (
		<section className="container mx-auto px-4 py-20 md:py-28">
			<div className="mx-auto max-w-5xl">
				<div className="max-w-2xl">
					<SectionTitle title="Setting up agents yourself is a security risk" />
					<p className={sectionSubtitleClass}>
						One misconfiguration away from a leak. Ryu ships secure by default.
					</p>
				</div>

				<div className="mt-14 grid gap-6 md:grid-cols-2">
					<Reveal>
						<RiskCard />
					</Reveal>
					<Reveal delay={0.08}>
						<DefenseCard />
					</Reveal>
				</div>

				<p className="mt-10 flex max-w-xl items-center gap-2 font-medium text-muted-foreground text-sm md:text-base">
					<BadgeCheck
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
						strokeWidth={1.5}
					/>
					The industry standard for building secure team agents.
				</p>

				<div className="mt-16 md:mt-20">
					<div className="max-w-2xl">
						<SectionTitle title="A firewall in front of every agent" />
						<p className={sectionSubtitleClass}>
							Routing, firewall, DLP, budgets, and audit, with a console you
							control.
						</p>
					</div>
					<Reveal>
						<div className="mx-auto mt-10 max-w-3xl">
							<GatewayMock />
						</div>
					</Reveal>
				</div>
			</div>
		</section>
	);
}
