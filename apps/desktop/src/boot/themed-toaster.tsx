import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useTheme } from "next-themes";

/** Toasts follow the app's resolved theme, not the OS preference. */
export function ThemedToaster() {
	const { resolvedTheme } = useTheme();
	return <Toaster position="bottom-right" theme={resolvedTheme} />;
}
