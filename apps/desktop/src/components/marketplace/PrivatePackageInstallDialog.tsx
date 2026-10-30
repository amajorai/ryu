import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ryu/ui/components/dialog.tsx";
import { ConnectionPermissionDialog } from "@/src/components/marketplace/ConnectionPermissionDialog.tsx";
import { PrivatePackageEntryForm } from "./private-package/PrivatePackageEntryForm.tsx";
import { PrivatePackagePreview } from "./private-package/PrivatePackagePreview.tsx";
import { usePrivatePackageInstall } from "./private-package/use-private-package-install.ts";

export default function PrivatePackageInstallDialog({
	onClose,
	open,
}: {
	onClose: () => void;
	open: boolean;
}) {
	const state = usePrivatePackageInstall(open);
	const {
		handleConnect,
		permissionRequirement,
		preview,
		setPermissionRequirement,
		stage,
	} = state;

	return (
		<>
			<Dialog
				onOpenChange={(nextOpen) => {
					if (!nextOpen) {
						onClose();
					}
				}}
				open={open}
			>
				<DialogContent appearance="package-install">
					<DialogHeader className="text-left" purpose="package-install">
						<DialogTitle>Install a private package</DialogTitle>
						<DialogDescription>
							Enter your publisher's code. You'll review what it needs first.
						</DialogDescription>
					</DialogHeader>

					<div className="scroll-fade max-h-[calc(88vh-10rem)] overflow-y-auto px-6 py-5">
						{stage === "entry" ? (
							<PrivatePackageEntryForm state={state} />
						) : preview ? (
							<PrivatePackagePreview
								onClose={onClose}
								preview={preview}
								state={state}
							/>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
			<ConnectionPermissionDialog
				connectionName={
					permissionRequirement?.displayName ?? "this integration"
				}
				connectionType="Composio"
				onConfirm={async (accessLevel) => {
					if (!permissionRequirement) {
						return;
					}
					await handleConnect(permissionRequirement, accessLevel);
					setPermissionRequirement(null);
				}}
				onOpenChange={(open) => {
					if (!open) {
						setPermissionRequirement(null);
					}
				}}
				open={permissionRequirement !== null}
			/>
		</>
	);
}
