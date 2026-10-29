import { cn } from "@ryu/ui/lib/utils.ts";

interface AspectRatioStyle extends React.CSSProperties {
	"--ratio": number;
}

function AspectRatio({
	ratio,
	className,
	appearance = "default",
	...props
}: React.ComponentProps<"div"> & {
	ratio: number;
	appearance?: "default" | "muted";
}) {
	const style: AspectRatioStyle = { "--ratio": ratio };
	return (
		<div
			className={cn(
				"relative aspect-(--ratio)",
				appearance === "muted" && "rounded-xl bg-muted",
				className
			)}
			data-slot="aspect-ratio"
			style={style}
			{...props}
		/>
	);
}

export { AspectRatio };
