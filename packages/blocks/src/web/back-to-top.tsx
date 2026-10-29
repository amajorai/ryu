"use client";

import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { ArrowUp } from "lucide-react";

/** Footer control that returns to the top of the page, beside the theme toggle. */
export function BackToTop() {
	const label = useLocalizedString("Back to top") ?? "Back to top";

	const scrollToTop = () => {
		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)"
		).matches;
		window.scrollTo({ behavior: reduceMotion ? "auto" : "smooth", top: 0 });
	};

	return (
		<Button onClick={scrollToTop} size="icon" title={label} variant="ghost">
			<ArrowUp aria-hidden="true" className="size-[1.1rem]" />
			<span className="sr-only">{label}</span>
		</Button>
	);
}
