import { ArrowRight01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { DialogFooter } from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Spinner } from "@ryu/ui/components/spinner.tsx";
import { formatPrivatePackageShareCode } from "@/src/lib/api/marketplace.ts";
import { ErrorNotice } from "./PrivatePackageParts.tsx";
import type { PrivatePackageInstallState } from "./use-private-package-install.ts";

/** Step one: enter and preview a publisher's package code. */
export function PrivatePackageEntryForm({
	state,
}: {
	state: PrivatePackageInstallState;
}) {
	const tl = useLiteralMessages();
	const { canPreview, code, error, handlePreview, loading, setCode } = state;
	return (
		<form
			className="space-y-5"
			onSubmit={(event) => {
				event.preventDefault();
				if (canPreview) {
					void handlePreview();
				}
			}}
		>
			<div className="rounded-xl bg-muted p-4">
				<div className="mb-3 flex items-center gap-2 font-medium text-sm">
					<HugeiconsIcon
						className="size-4 text-muted-foreground"
						icon={Shield01Icon}
					/>
					Private by default
				</div>
				<p className="text-muted-foreground text-sm leading-6">
					The code grants access to one package release. It does not contain
					credentials, and it can be revoked by the publisher.
				</p>
			</div>
			<label className="block space-y-2" htmlFor="private-package-code">
				<span className="font-medium text-sm">Package code</span>
				<Input
					id="private-package-code"
					inputMode="text"
					maxLength={14}
					onBlur={() => setCode(formatPrivatePackageShareCode(code))}
					onChange={(event) => setCode(event.target.value.toUpperCase())}
					placeholder="7K4M-X2QP-9F6D"
					spellCheck={false}
					value={code}
				/>
				<span className="text-muted-foreground text-xs">
					12 characters · letters and numbers · hyphens are optional
				</span>
			</label>
			{error ? <ErrorNotice message={error} /> : null}
			<DialogFooter purpose="package-actions">
				<Button disabled={!canPreview} type="submit">
					{loading ? <Spinner className="size-4" /> : null}
					{tl("Preview package")}
					{loading ? null : (
						<HugeiconsIcon className="size-4" icon={ArrowRight01Icon} />
					)}
				</Button>
			</DialogFooter>
		</form>
	);
}
