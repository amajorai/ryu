import { Button } from "@ryu/ui/components/button";
import { cn } from "@ryu/ui/lib/utils";

export interface ErrorMessageProps {
	className?: string;
	message: string;
	onRetry?: () => void;
	title?: string;
}

export function ErrorMessage({
	title,
	message,
	onRetry,
	className,
}: ErrorMessageProps) {
	return (
		<div className={cn("rounded-(--radius) bg-muted px-3 py-2", className)}>
			{title && (
				<p className="mb-0.5 font-medium text-sm text-status-destructive">
					{title}
				</p>
			)}
			<p className="text-muted-foreground text-xs">{message}</p>
			{onRetry ? (
				<Button
					className="mt-2"
					onClick={onRetry}
					size="sm"
					type="button"
					variant="outline"
				>
					Retry
				</Button>
			) : null}
		</div>
	);
}
