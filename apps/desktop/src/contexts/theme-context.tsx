import { createContext, useContext, useEffect, useState } from "react";
import { type ColorTheme, colorThemes } from "../lib/themes/color-themes.ts";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
	colorTheme: ColorTheme;
	setColorTheme: (theme: ColorTheme) => void;
	setTheme: (theme: Theme) => void;
	theme: Theme;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	const [theme, setTheme] = useState<Theme>(() => {
		if (typeof window !== "undefined") {
			return (localStorage.getItem("theme") as Theme) || "system";
		}
		return "system";
	});

	const [colorTheme, setColorTheme] = useState<ColorTheme>(() => {
		if (typeof window !== "undefined") {
			const saved = localStorage.getItem("colorTheme");
			if (saved) {
				return colorThemes.find((t) => t.name === saved) || colorThemes[0];
			}
		}
		return colorThemes[0];
	});

	useEffect(() => {
		const root = window.document.documentElement;

		root.classList.remove("light", "dark");

		if (theme === "system") {
			const systemTheme = window.matchMedia("(prefers-color-scheme: dark)")
				.matches
				? "dark"
				: "light";
			root.classList.add(systemTheme);
		} else {
			root.classList.add(theme);
		}

		localStorage.setItem("theme", theme);
	}, [theme]);

	useEffect(() => {
		const root = window.document.documentElement;
		const isDark = root.classList.contains("dark");

		// Set the primary color CSS variable
		if (colorTheme.name === "default") {
			root.style.setProperty(
				"--primary",
				isDark ? colorTheme.dark.primary : colorTheme.light.primary
			);
		} else {
			root.style.setProperty(
				"--primary",
				isDark ? colorTheme.dark.primary : colorTheme.light.primary
			);
		}

		localStorage.setItem("colorTheme", colorTheme.name);
	}, [colorTheme]);

	return (
		<ThemeContext.Provider
			value={{ theme, setTheme, colorTheme, setColorTheme }}
		>
			{children}
		</ThemeContext.Provider>
	);
}

export function useTheme() {
	const context = useContext(ThemeContext);
	if (context === undefined) {
		throw new Error("useTheme must be used within a ThemeProvider");
	}
	return context;
}
