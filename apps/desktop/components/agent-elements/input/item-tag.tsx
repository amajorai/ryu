/** The small trailing tag a setting or model row can wear ("Free"). */
export function ItemTag({ tag }: { tag: string }) {
	return (
		<span className="shrink-0 rounded-sm bg-muted px-1.5 py-px font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
			{tag}
		</span>
	);
}
