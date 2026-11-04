// packages/marketplace/src/catalog/detail/api-reference-raw-token.tsx
//
// The API-reference tab's fallback for a manifest token this build has no
// translated name for: a translated generic label, then the token itself in a
// code chip. The token is an identifier, not prose, so it is shown verbatim and
// marked as code instead of being spliced into a translated sentence.

export function RawToken({ label, token }: { label: string; token: string }) {
	return (
		<>
			{label}{" "}
			<code className="rounded bg-background/60 px-1 font-mono text-[0.85em]">
				{token}
			</code>
		</>
	);
}
