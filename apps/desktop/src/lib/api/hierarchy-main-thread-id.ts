import { isNativeText } from "@ryu/ui/lib/native-primitive-observation.ts";

export function acknowledgedMainThreadId<TValue>(value: TValue): string {
	if (!(isNativeText(value) && value.trim()) || value !== value.trim()) {
		throw new Error(
			"The node returned no main thread id. Reload the project before opening its thread."
		);
	}
	return value;
}
