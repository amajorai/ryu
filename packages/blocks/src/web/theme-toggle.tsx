"use client";

import { Button } from "@ryu/ui/components/button";
import { ClassicThemeIcon } from "@ryu/ui/components/classic-theme-icon";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	// useEffect only runs on the client, so now we can safely show the UI
	useEffect(() => {
		setMounted(true);
	}, []);

	const toggleTheme = () =>
		setTheme(resolvedTheme === "dark" ? "light" : "dark");

	if (!mounted) {
		return (
			<Button disabled size="icon" variant="ghost">
				<ClassicThemeIcon className="size-[1.2rem]" />
				<span className="sr-only">Toggle theme</span>
			</Button>
		);
	}

	return (
		<Button onClick={toggleTheme} size="icon" variant="ghost">
			<ClassicThemeIcon className="size-[1.2rem]" />
			<span className="sr-only">Toggle theme</span>
		</Button>
	);
}
