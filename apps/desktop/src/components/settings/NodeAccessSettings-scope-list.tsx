export function ScopeList({
	emptyLabel,
	label,
	scopes,
}: {
	emptyLabel: string;
	label: string;
	scopes?: string[];
}) {
	return (
		<div className="mt-2">
			<p className="text-muted-foreground text-xs">{label}</p>
			{scopes && scopes.length > 0 ? (
				<ul aria-label={label} className="mt-1 flex flex-wrap gap-1">
					{scopes.map((scope) => (
						<li
							className="rounded-lg bg-muted px-1.5 py-0.5 font-mono text-xs"
							key={scope}
						>
							{scope}
						</li>
					))}
				</ul>
			) : (
				<p className="mt-1 text-muted-foreground text-xs">{emptyLabel}</p>
			)}
		</div>
	);
}
