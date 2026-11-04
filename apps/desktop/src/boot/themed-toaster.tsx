import { useDirection } from "@ryu/ui/components/direction.tsx";
import { Toaster } from "@ryu/ui/components/sileo.tsx";
import { useTheme } from "next-themes";

/** Sileo places toasts physically; keep them in the inline-end corner. */
export function toasterPosition(
	direction: string | undefined
): "bottom-left" | "bottom-right" {
	return direction === "rtl" ? "bottom-left" : "bottom-right";
}

/** Toasts follow the app's resolved theme, not the OS preference. */
export function ThemedToaster() {
	const { resolvedTheme } = useTheme();
	const direction = useDirection();
	return (
		<Toaster position={toasterPosition(direction)} theme={resolvedTheme} />
	);
}
