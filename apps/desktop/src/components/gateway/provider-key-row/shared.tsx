import { ApiError } from "@/src/lib/api/client.ts";

export function gatewayAccountErrorMessage(
	cause: unknown,
	fallback: string
): string {
	if (cause instanceof ApiError) {
		return cause.serverMessage ?? cause.message;
	}
	return cause instanceof Error ? cause.message : fallback;
}

export function ManagedKeyNote({ note }: { note: string }) {
	return <p className="text-muted-foreground text-xs">{note}</p>;
}
