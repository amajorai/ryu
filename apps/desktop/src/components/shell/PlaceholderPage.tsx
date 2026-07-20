// apps/desktop/src/components/shell/PlaceholderPage.tsx
//
// Route stub for planned desktop views. DA0 scaffolds the nav + routes; each
// feature unit (DA1-DA10) replaces its page with the real implementation. The
// `unit` tag makes it obvious which issue owns the view.

interface PlaceholderPageProps {
	description: string;
	title: string;
	unit: string;
}

export function PlaceholderPage({
	title,
	description,
	unit,
}: PlaceholderPageProps) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
			<h1 className="font-semibold text-lg">{title}</h1>
			<p className="max-w-md text-muted-foreground text-sm">{description}</p>
			<span className="mt-2 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs">
				Coming in {unit}
			</span>
		</div>
	);
}
