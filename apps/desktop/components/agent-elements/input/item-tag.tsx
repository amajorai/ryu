/** The small trailing tag a setting or model row can wear ("Free"). */
export function ItemTag({ tag }: { tag: string }) {
	return (
		<span className="shrink-0 rounded-full bg-muted px-1.5 text-muted-foreground text-xs">
			{tag}
		</span>
	);
}
