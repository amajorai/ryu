import { ArrowUpRight } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { products } from "./data/products.tsx";
import type { LandingCardTone } from "./landing-card-tones.ts";
import {
	LANDING_CARD_TONES,
	landingCardSurfaceClass,
} from "./landing-card-tones.ts";
import { landingHeadlineClass } from "./landing-typography.ts";
import { sectionSubtitleClass } from "./sections.tsx";

const SERVICE_TONES: Record<string, LandingCardTone> = {
	box: "orange",
	gateway: "yellow",
	mail: "blue",
	notify: "purple",
};

const SERVICE_ENDPOINTS: Record<string, string> = {
	box: "Persistent workspace API",
	gateway: "Model + tool gateway",
	hire: "Pay-per-run specialists",
	mail: "Agent inbox API",
	notify: "POST /v1/events",
};

const STANDALONE_PRODUCTS = products.filter((product) => product.standalone);

export function StandaloneServicesSection() {
	return (
		<section
			aria-label="Standalone services"
			className="mx-auto max-w-6xl px-6 py-20 md:py-28"
			data-testid="standalone-services"
			id="standalone-services"
		>
			<div className="max-w-2xl">
				<h2 className={landingHeadlineClass}>Use the pieces as services.</h2>
				<p className={sectionSubtitleClass}>
					Ryu Gateway, Box, Mail, Notify, and Hire each own a focused service
					boundary. Connect only the service your product needs, or use them
					together around one agent.
				</p>
			</div>

			<div className="mt-12 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
				{STANDALONE_PRODUCTS.map((product) => {
					const Icon = product.Icon;
					const tone =
						LANDING_CARD_TONES[SERVICE_TONES[product.slug] ?? "blue"];
					return (
						<Link
							className={landingCardSurfaceClass(
								SERVICE_TONES[product.slug] ?? "blue"
							)}
							data-testid={`standalone-service-${product.slug}`}
							href={`/products/${product.slug}` as Route}
							key={product.slug}
						>
							<div className={`flex items-center gap-2 text-sm ${tone.title}`}>
								<Icon aria-hidden="true" className="size-4" />
								<span>{product.name}</span>
							</div>
							<p
								className={`mt-5 font-mono text-[10px] uppercase tracking-wider ${tone.eyebrow}`}
							>
								{SERVICE_ENDPOINTS[product.slug] ?? "Standalone API"}
							</p>
							<p className={`mt-2 text-sm leading-relaxed ${tone.body}`}>
								{product.tagline}
							</p>
							<div
								className={`mt-8 flex items-center justify-between text-xs ${tone.ctaSecondary}`}
							>
								<span>Explore</span>
								<ArrowUpRight aria-hidden="true" className="size-4" />
							</div>
						</Link>
					);
				})}
			</div>
		</section>
	);
}
