import { cn } from "@ryu/ui/lib/utils";

// Bundled locally under apps/web/public/logos (originally from svgl.app).
const SVGL = "/logos";

interface ThemedLogo {
	dark: string;
	kind: "themed";
	light: string;
}
interface MonoLogo {
	kind: "mono";
	src: string;
}
interface ColorLogo {
	kind: "color";
	src: string;
}
interface LocalLogo {
	kind: "local";
	src: string;
}

interface Program {
	href: string;
	label: string;
	logo: ColorLogo | LocalLogo | MonoLogo | ThemedLogo;
	name: string;
}

const PROGRAMS: Program[] = [
	{
		name: "AWS",
		label: "AWS Activate",
		href: "https://aws.amazon.com/activate/",
		logo: {
			kind: "themed",
			light: `${SVGL}/aws_light.svg`,
			dark: `${SVGL}/aws_dark.svg`,
		},
	},
	{
		name: "BLOCK71",
		label: "BLOCK71",
		href: "https://block71.co/",
		logo: { kind: "local", src: "/block71.png" },
	},
	// {
	// 	name: "Enterprise Singapore",
	// 	label: "Enterprise Singapore",
	// 	href: "https://www.enterprisesg.gov.sg/",
	// 	logo: {
	// 		kind: "themed",
	// 		light: "/enterprise-singapore.svg",
	// 		dark: "/enterprise-singapore-dark.svg",
	// 	},
	// },
	// {
	// 	name: "Startup SG",
	// 	label: "Startup SG",
	// 	href: "https://www.startupsg.gov.sg/",
	// 	logo: { kind: "local", src: "/startup-sg.png" },
	// },
	{
		name: "Claude",
		label: "Claude",
		href: "https://www.anthropic.com/",
		logo: {
			kind: "themed",
			light: `${SVGL}/anthropic_black_wordmark.svg`,
			dark: `${SVGL}/anthropic_white_wordmark.svg`,
		},
	},
	{
		name: "OpenAI",
		label: "OpenAI",
		href: "https://openai.com/",
		logo: {
			kind: "themed",
			light: `${SVGL}/openai_wordmark_light.svg`,
			dark: `${SVGL}/openai_wordmark_dark.svg`,
		},
	},
	{
		name: "Google",
		label: "Google",
		href: "https://startup.google.com/",
		logo: { kind: "mono", src: `${SVGL}/google-wordmark.svg` },
	},
	{
		name: "NVIDIA",
		label: "NVIDIA Inception",
		href: "https://www.nvidia.com/en-us/deep-learning-ai/startups/",
		logo: {
			kind: "themed",
			light: `${SVGL}/nvidia-wordmark-light.svg`,
			dark: `${SVGL}/nvidia-wordmark-dark.svg`,
		},
	},
	{
		name: "Notion",
		label: "Notion",
		href: "https://www.notion.so/",
		logo: { kind: "color", src: `${SVGL}/notion.svg` },
	},
	{
		name: "Cloudflare",
		label: "Cloudflare",
		href: "https://www.cloudflare.com/",
		logo: { kind: "color", src: `${SVGL}/cloudflare.svg` },
	},
	{
		name: "PostHog",
		label: "PostHog",
		href: "https://posthog.com/startups",
		logo: {
			kind: "themed",
			light: `${SVGL}/posthog-wordmark.svg`,
			dark: `${SVGL}/posthog-wordmark_dark.svg`,
		},
	},
	{
		name: "Sentry",
		label: "Sentry",
		href: "https://sentry.io/for/startups/",
		logo: { kind: "color", src: `${SVGL}/sentry.svg` },
	},
	{
		name: "LangChain",
		label: "LangChain",
		href: "https://www.langchain.com/",
		logo: { kind: "local", src: "/logos/langchain.svg" },
	},
	{
		name: "Polar",
		label: "Polar",
		href: "https://polar.sh/",
		logo: {
			kind: "themed",
			light: `${SVGL}/polar-sh_light.svg`,
			dark: `${SVGL}/polar-sh_dark.svg`,
		},
	},
	{
		name: "Stripe",
		label: "Stripe",
		href: "https://stripe.com/",
		logo: { kind: "color", src: `${SVGL}/stripe_wordmark.svg` },
	},
	{
		name: "DigitalOcean",
		label: "DigitalOcean",
		href: "https://www.digitalocean.com/hatch",
		logo: { kind: "color", src: `${SVGL}/digitalocean.svg` },
	},
	{
		name: "Modal",
		label: "Modal",
		href: "https://modal.com/",
		logo: { kind: "mono", src: "/logos/modal.svg" },
	},
	{
		name: "Snyk",
		label: "Snyk",
		href: "https://snyk.io/",
		logo: { kind: "mono", src: "/logos/snyk.svg" },
	},
];

const wordmarkClass = "h-4 w-auto max-w-none shrink-0 select-none sm:h-5";
const monoWordmarkClass = `${wordmarkClass} brightness-0 dark:invert`;

const programLinkClass =
	"inline-flex shrink-0 items-center opacity-80 transition-opacity hover:opacity-100";

function ProgramWordmark({ program }: { program: Program }) {
	const { logo, name } = program;

	if (logo.kind === "themed") {
		return (
			<>
				<img
					alt={name}
					className={`${wordmarkClass} dark:hidden`}
					height={24}
					loading="lazy"
					src={logo.light}
					width={120}
				/>
				<img
					alt={name}
					className={`${wordmarkClass} hidden dark:block`}
					height={24}
					loading="lazy"
					src={logo.dark}
					width={120}
				/>
			</>
		);
	}

	if (logo.kind === "mono") {
		return (
			<img
				alt={name}
				className={monoWordmarkClass}
				height={24}
				loading="lazy"
				src={logo.src}
				width={120}
			/>
		);
	}

	return (
		<img
			alt={name}
			className={cn(wordmarkClass, name === "Notion" && "dark:invert")}
			height={24}
			loading="lazy"
			src={logo.src}
			width={120}
		/>
	);
}

export default function StartupPrograms() {
	return (
		<section className="container mx-auto mt-10 px-4 pb-32 md:mt-14 md:pb-44">
			<div className="mx-auto max-w-6xl text-center">
				<h2 className="font-medium text-muted-foreground text-sm">
					Backed by leading startup programs
				</h2>

				<div className="group relative mt-4 overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_4%,black_96%,transparent)]">
					<div className="flex w-max animate-marquee items-center gap-10 py-1 sm:gap-14 md:gap-16 group-hover:[animation-play-state:paused]">
						{[...PROGRAMS, ...PROGRAMS].map((program, i) => (
							<a
								aria-label={program.label}
								className={programLinkClass}
								href={program.href}
								// biome-ignore lint/suspicious/noArrayIndexKey: duplicated static marquee list
								key={`${program.name}-${i}`}
								rel="noopener noreferrer"
								target="_blank"
							>
								<ProgramWordmark program={program} />
							</a>
						))}
					</div>
				</div>
			</div>
		</section>
	);
}
