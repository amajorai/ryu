// apps/desktop/src/components/agents/AcpSessionControls-error-message.ts
//
// Shared error-to-message fallback for the ACP session controls sections.

export function errMessage<TError>(e: TError, fallback: string): string {
	return e instanceof Error ? e.message : fallback;
}
