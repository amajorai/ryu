"use client";

import { buttonVariants } from "@ryu/ui/components/button";
import { toast } from "@ryu/ui/components/sileo.tsx";
import { cn } from "@ryu/ui/lib/utils";
import type { MouseEvent } from "react";
import { SETUP_RYU_HREF, SETUP_RYU_LABEL } from "./data/resources.tsx";
import { SvglIcon } from "./svgl-icon.tsx";

/** The coding agents a visitor is likely to paste the setup prompt into. */
const AGENT_LOGOS = [
	{ name: "Claude", slug: "claude", monochrome: false },
	{ name: "OpenAI", slug: "openai", monochrome: true },
	{ name: "Gemini", slug: "gemini", monochrome: false },
	{ name: "Cursor", slug: "cursor", monochrome: true },
] as const;

/**
 * A short instruction that points the agent at the hosted playbook. The
 * playbook itself stays at `/setup-ryu.md`, so the clipboard holds one line
 * the visitor can read before pasting, and the agent always fetches the
 * current version.
 */
export function setupRyuPrompt(origin: string): string {
	return `Set up Ryu for me. Read ${origin}${SETUP_RYU_HREF} and follow its instructions.`;
}

function AgentLogoGroup() {
	return (
		<span aria-hidden="true" className="flex -space-x-1.5">
			{AGENT_LOGOS.map((logo) => (
				// Frosted glass chips: the page shows through, blurred, and a hairline
				// ring keeps each one distinct where they overlap.
				<span
					className="grid size-6 place-items-center rounded-full bg-background/40 ring-1 ring-foreground/15 backdrop-blur-md"
					key={logo.slug}
				>
					<SvglIcon
						className={logo.monochrome ? "dark:invert" : undefined}
						size={14}
						spec={logo.slug}
					/>
				</span>
			))}
		</span>
	);
}

/**
 * Copies a one-line "set up Ryu" prompt for the visitor's own agent. It stays
 * a real link to the playbook, so a modified click (new tab) or no-JS visit
 * still opens the markdown.
 */
export function SetupRyuButton({ className }: { className?: string }) {
	const copyPrompt = async (event: MouseEvent<HTMLAnchorElement>) => {
		if (
			event.button !== 0 ||
			event.metaKey ||
			event.ctrlKey ||
			event.shiftKey ||
			event.altKey
		) {
			return;
		}
		event.preventDefault();
		const prompt = setupRyuPrompt(window.location.origin);
		try {
			await navigator.clipboard.writeText(prompt);
			toast.success("Copied. Paste it into your agent");
		} catch {
			toast.error("Couldn't copy the prompt");
		}
	};

	return (
		<a
			className={cn(
				buttonVariants({ radius: "pill", size: "lg", variant: "ghost" }),
				"gap-3",
				className
			)}
			data-testid="setup-ryu-button"
			href={SETUP_RYU_HREF}
			onClick={copyPrompt}
		>
			<AgentLogoGroup />
			{SETUP_RYU_LABEL}
		</a>
	);
}
