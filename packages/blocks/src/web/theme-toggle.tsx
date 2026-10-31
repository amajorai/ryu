"use client";

import { useLocalizedString } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button";
import { ClassicThemeIcon } from "@ryu/ui/components/classic-theme-icon";
import { Laptop } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

type ThemePreference = "light" | "dark" | "system";

/** Light → Dark → System (follow the device) → Light. */
const NEXT_THEME: Record<ThemePreference, ThemePreference> = {
	light: "dark",
	dark: "system",
	system: "light",
};

const THEME_LABEL: Record<ThemePreference, string> = {
	light: "Theme: Light",
	dark: "Theme: Dark",
	system: "Theme: System",
};

function toPreference(theme: string | undefined): ThemePreference {
	return theme === "light" || theme === "dark" ? theme : "system";
}

export function ThemeToggle() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// useEffect only runs on the client, so now we can safely show the UI
	useEffect(() => {
		setMounted(true);
	}, []);

	const preference = toPreference(theme);
	// A string, not a ReactNode: the label also feeds the button's `title`.
	const fallbackLabel = mounted ? THEME_LABEL[preference] : "Toggle theme";
	const label = useLocalizedString(fallbackLabel) ?? fallbackLabel;

	if (!mounted) {
		return (
			<Button disabled size="icon" variant="ghost">
				<ClassicThemeIcon className="size-[1.2rem]" />
				<span className="sr-only">{label}</span>
			</Button>
		);
	}

	return (
		<Button
			onClick={() => setTheme(NEXT_THEME[preference])}
			size="icon"
			title={label}
			variant="ghost"
		>
			{preference === "system" ? (
				<Laptop aria-hidden="true" className="size-[1.2rem]" />
			) : (
				<ClassicThemeIcon className="size-[1.2rem]" />
			)}
			<span className="sr-only">{label}</span>
		</Button>
	);
}
