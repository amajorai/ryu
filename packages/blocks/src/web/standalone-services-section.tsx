"use client";

import { useLiteralMessages } from "@ryu/i18n/react";
import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { copyMarker as t } from "./copy-marker.ts";
import { products } from "./data/products.tsx";
import { landingVisualFrameClass } from "./landing-card-tones.ts";
import { SectionTitle, sectionSubtitleClass } from "./sections.tsx";

const SERVICE_DESCRIPTIONS = new Map(
	Object.entries({
		connect: t(
			"Host MCP, Skills, governed tools, and Composio behind one tenant edge."
		),
		gateway: t(
			"Route model and tool requests with shared access rules and budgets."
		),
		box: t("Give agents a persistent workspace for files and code."),
		notify: t("Send notifications through one API."),
		mail: t("Give agents an inbox to send and receive email."),
		messaging: t(
			"Send SMS, WhatsApp, and voice messages from numbers you lease."
		),
		sites: t("Deploy reviewed websites with a separate visitor origin."),
		passport: t("Keep agent identity connections encrypted and explicit."),
	})
);

/**
 * Standalone products this API-oriented section leaves out because they have
 * no public API. Ryu Hire is early access with no runtime or API contract.
 */
const SERVICES_WITHOUT_PUBLIC_API = new Set(["hire"]);

export const apiStandaloneServices = products.filter(
	(product) =>
		product.standalone && !SERVICES_WITHOUT_PUBLIC_API.has(product.slug)
);

export function StandaloneServicesSection() {
	const tl = useLiteralMessages();
	const services = apiStandaloneServices;
	const [selectedSlug, setSelectedSlug] = useState("gateway");
	const selected =
		services.find((product) => product.slug === selectedSlug) ?? services[0];
	return (
		<section
			aria-label={tl("Standalone services")}
			className="mx-auto max-w-6xl px-6 py-16 md:py-24"
			data-testid="standalone-services"
			id="standalone-services"
		>
			<div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
				<div>
					<SectionTitle title="Add Ryu to your product" />
					<p className={sectionSubtitleClass}>
						Use an individual service through its API. Keep your app and add the
						capabilities you need.
					</p>
					<div
						className={`${landingVisualFrameClass} mt-10 flex min-h-72 items-center justify-center md:min-h-96 [&>*]:w-full`}
						data-product-visual
					>
						{selected?.hero.visual}
					</div>
				</div>
				<div className="space-y-6">
					{services.map((product) => (
						<Link
							className="group flex items-start justify-between gap-6 py-2 outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
							data-testid={`standalone-service-${product.slug}`}
							href={`/products/${product.slug}`}
							key={product.slug}
							onFocus={() => setSelectedSlug(product.slug)}
							onMouseEnter={() => setSelectedSlug(product.slug)}
						>
							<div>
								<h3 className="font-medium group-hover:underline group-hover:underline-offset-4">
									{product.name}
								</h3>
								<p className="mt-2 max-w-md text-muted-foreground text-sm leading-relaxed">
									{tl(
										SERVICE_DESCRIPTIONS.get(product.slug) ?? product.tagline
									)}
								</p>
							</div>
							<ArrowUpRight
								aria-hidden="true"
								className="mt-1 size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
							/>
						</Link>
					))}
				</div>
			</div>
		</section>
	);
}
