import { cn } from "@ryu/ui/lib/utils";

export interface ErrorMessageProps {
	className?: string;
	message: string;
	title?: string;
}

export function ErrorMessage({ title, message, className }: ErrorMessageProps) {
	return (
		<div
			className={cn("rounded-[var(--radius)] bg-muted px-3 py-2", className)}
		>
			{title && (
				<p className="mb-0.5 font-medium text-destructive text-sm">{title}</p>
			)}
			<p className="text-muted-foreground text-xs">{message}</p>
		</div>
	);
}
