"use client";

import { useMounted } from "@ryu/ui/hooks/use-mounted.ts";
import { cn } from "@ryu/ui/lib/utils";
import styles from "./startup-programs.module.css";

// Bundled locally under apps/web/public/logos (originally from svgl.app).
const SVGL = "/logos";

interface Program {
	href: string;
	label: string;
	name: string;
	/**
	 * Symbol-only marks render slightly taller than wordmarks and carry the name
	 * beside them. "name" renders the name alone, for a mark that turns into an
	 * unreadable block once it is monochrome.
	 */
	shape: "name" | "symbol" | "wordmark";
	src?: string;
}

/*
 * Only entries that link to the startup program itself. Company homepages
 * (OpenAI, Notion, Cloudflare, LangChain, Polar, Stripe, Modal, Snyk)
 * were removed until a program membership is confirmed for each.
 */
const PROGRAMS: Program[] = [
	{
		name: "Anthropic",
		label: "Claude for Startups",
		href: "https://claude.com/programs/startups",
		shape: "wordmark",
		src: `${SVGL}/anthropic_black_wordmark.svg`,
	},
	{
		name: "AWS",
		label: "AWS Activate",
		href: "https://aws.amazon.com/activate/",
		shape: "wordmark",
		src: `${SVGL}/aws_light.svg`,
	},
	{
		name: "BLOCK71",
		label: "BLOCK71",
		href: "https://block71.co/",
		shape: "name",
	},
	{
		name: "Google",
		label: "Google for Startups",
		href: "https://startup.google.com/",
		shape: "wordmark",
		src: `${SVGL}/google-wordmark.svg`,
	},
	{
		name: "NVIDIA",
		label: "NVIDIA Inception",
		href: "https://www.nvidia.com/en-us/deep-learning-ai/startups/",
		shape: "wordmark",
		src: `${SVGL}/nvidia-wordmark-light.svg`,
	},
	{
		name: "PostHog",
		label: "PostHog for Startups",
		href: "https://posthog.com/startups",
		shape: "wordmark",
		src: `${SVGL}/posthog-wordmark.svg`,
	},
	{
		name: "Sentry",
		label: "Sentry for Startups",
		href: "https://sentry.io/for/startups/",
		shape: "symbol",
		src: `${SVGL}/sentry.svg`,
	},
	{
		name: "Datadog",
		label: "Datadog for Startups",
		href: "https://www.datadoghq.com/partner/datadog-for-startups/",
		shape: "symbol",
		src: `${SVGL}/datadog.svg`,
	},
	{
		name: "DigitalOcean",
		label: "DigitalOcean Hatch",
		href: "https://www.digitalocean.com/hatch",
		shape: "symbol",
		src: `${SVGL}/digitalocean.svg`,
	},
];

/* Every mark renders monochrome so no single brand colour dominates the strip. */
const logoClass =
	"w-auto max-w-none shrink-0 select-none brightness-0 dark:invert";
const LOGO_HEIGHT = {
	name: "h-5",
	symbol: "h-5",
	wordmark: "h-4",
} as const satisfies Record<Program["shape"], string>;

const programLinkClass =
	"inline-flex shrink-0 items-center opacity-60 transition-opacity hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring";

/**
 * Wordmarks render alone. A symbol-only mark is not readable as a name once it
 * is monochrome, so it carries the program name beside it.
 */
function ProgramWordmark({ program }: { program: Program }) {
	const nameClass =
		"inline-flex items-center gap-2 whitespace-nowrap font-heading font-semibold text-base text-foreground";
	if (program.shape === "name" || !program.src) {
		return <span className={nameClass}>{program.name}</span>;
	}
	const image = (
		<img
			alt={program.shape === "symbol" ? "" : program.name}
			className={cn(logoClass, LOGO_HEIGHT[program.shape])}
			height={24}
			loading="lazy"
			src={program.src}
			width={program.shape === "symbol" ? 24 : 120}
		/>
	);
	if (program.shape === "wordmark") {
		return image;
	}
	return (
		<span className={nameClass}>
			{image}
			{program.name}
		</span>
	);
}

function ProgramLinks({ loopCopy = false }: { loopCopy?: boolean }) {
	return PROGRAMS.map((program) => (
		<a
			aria-hidden={loopCopy || undefined}
			aria-label={program.label}
			className={programLinkClass}
			href={program.href}
			key={program.name}
			rel="noopener noreferrer"
			tabIndex={loopCopy ? -1 : undefined}
			target="_blank"
		>
			<ProgramWordmark program={program} />
		</a>
	));
}

export default function StartupPrograms({ className }: { className?: string }) {
	// The marquee loops by sliding a second copy of the row into view. That copy
	// is presentational, so the server sends one row and the client adds the
	// loop copy (hidden from assistive tech and the tab order) once mounted;
	// the row only starts sliding when both copies exist.
	const mounted = useMounted();
	return (
		<section
			aria-labelledby="backed-by-heading"
			className={cn(
				"mx-auto w-full max-w-6xl px-4 text-center md:px-6",
				className
			)}
			data-testid="backed-by-carousel"
		>
			<h2
				className="!text-sm font-medium text-muted-foreground"
				id="backed-by-heading"
			>
				Ryu is a partner with these companies
			</h2>

			<div className="group relative mt-4 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_4%,black_96%,transparent)]">
				<div
					className={cn(
						"flex w-max items-center gap-10 py-1 sm:gap-14 md:gap-16",
						mounted && styles.marquee
					)}
					data-testid="backed-by-marquee"
				>
					<ProgramLinks />
					{mounted ? <ProgramLinks loopCopy /> : null}
				</div>
			</div>
		</section>
	);
}
