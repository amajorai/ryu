import { useI18n } from "@ryu/i18n/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { SkeletonRows } from "@ryu/ui/components/skeleton.tsx";
import { type ReactNode, Suspense, useState } from "react";

/** Defer the first mount, then retain dialog state between later openings. */
export function DeferredSettingsDialog({
	children,
	open,
	onOpenChange,
	title,
}: {
	children: ReactNode;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
}) {
	const { t } = useI18n();
	const [hasOpened, setHasOpened] = useState(open);
	if (open && !hasOpened) {
		setHasOpened(true);
	}
	if (!(open || hasOpened)) {
		return null;
	}
	return (
		<Suspense
			fallback={
				<Dialog onOpenChange={onOpenChange} open={open}>
					<DialogContent appearance="deferred-settings">
						<DialogHeader className="sr-only">
							<DialogTitle>{t("settings.title", {}, title)}</DialogTitle>
							<DialogDescription>
								{t("settings.loading", {}, "Opening settings")}
							</DialogDescription>
						</DialogHeader>
						<SkeletonRows rows={6} spacing="library" />
					</DialogContent>
				</Dialog>
			}
		>
			{children}
		</Suspense>
	);
}
