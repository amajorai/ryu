export const LIST =
	"list-disc space-y-1 pl-6 text-sm leading-6 marker:text-muted-foreground";

export function Dot() {
	return (
		<span aria-hidden="true" className="px-1.5 text-muted-foreground">
			&middot;
		</span>
	);
}
