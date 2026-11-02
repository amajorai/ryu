import { afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { CSSProperties } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";

if (!GlobalRegistrator.isRegistered) {
	GlobalRegistrator.register();
}
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// next-themes and the prefs store touch the DOM on import.
const { createRoot } = await import("react-dom/client");
const { ThemeProvider } = await import("next-themes");
const { DEFAULT_FILE_TREE_PREFS } = await import("./useFileTreePrefs.ts");
const { useFileTreeThemeStyles } = await import("./useFileTreeThemeStyles.ts");
const { TREE_THEME_INHERIT } = await import("@/src/lib/pierre-themes.ts");

let root: Root | null = null;

afterEach(() => {
	act(() => root?.unmount());
	root = null;
	document.body.innerHTML = "";
});

/** Renders the hook under a forced app mode and returns its latest styles. */
function renderStyles(
	appTheme: "dark" | "light",
	lightTheme: string
): { current: () => CSSProperties | undefined } {
	let latest: CSSProperties | undefined;
	function Probe() {
		latest = useFileTreeThemeStyles({
			...DEFAULT_FILE_TREE_PREFS,
			darkTheme: lightTheme,
			lightTheme,
		});
		return null;
	}
	const host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	act(() =>
		root?.render(
			<ThemeProvider
				attribute="class"
				defaultTheme={appTheme}
				enableSystem={false}
				storageKey={`file-tree-theme-test-${appTheme}`}
			>
				<Probe />
			</ThemeProvider>
		)
	);
	return { current: () => latest };
}

test("inherit pins the tree host to the app's mode and pushes no theme variables", () => {
	const styles = renderStyles("dark", TREE_THEME_INHERIT);
	expect(styles.current()).toEqual({ colorScheme: "dark" });
});

test("a theme that does not resolve keeps the app's mode instead of the OS's", async () => {
	const styles = renderStyles("light", "not-a-shiki-theme");
	// While the theme loads the host must not fall back to `light dark`.
	expect(styles.current()).toEqual({ colorScheme: "light" });
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(styles.current()).toEqual({ colorScheme: "light" });
});

test("a picked theme brings its own scheme and tree variables", async () => {
	const styles = renderStyles("dark", "github-light");
	await act(async () => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			if (Object.keys(styles.current() ?? {}).length > 1) {
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	});
	const resolved = styles.current() ?? {};
	expect(resolved.colorScheme).toBe("light");
	expect(
		Object.keys(resolved).some((key) => key.startsWith("--trees-theme-"))
	).toBe(true);
});
