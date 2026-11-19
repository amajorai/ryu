// A credential Core returns exactly once (a secret id or a machine token),
// shown read-only with a copy button. The value lives only in the caller's
// component state, so it is gone once the dialog showing it closes. The
// field takes focus when it appears, since the button that issued it is gone.

import { Copy01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import { useEffect, useRef } from "react";
import { sileo } from "sileo";

export function VaultShownOnce({
	id,
	label,
	onDone,
	value,
}: {
	id: string;
	label: string;
	onDone: () => void;
	value: string;
}) {
	const tl = useLiteralMessages();
	const field = useRef<HTMLInputElement>(null);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const copy = async () => {
		try {
			await navigator.clipboard.writeText(value);
			sileo.success({ title: tl("Copied") });
		} catch {
			sileo.error({ title: tl("Could not copy") });
		}
	};
	return (
		<div className="space-y-1.5 rounded-md border p-3">
			<Label htmlFor={id}>{label}</Label>
			<div className="flex gap-2">
				<Input
					aria-describedby={`${id}-note`}
					className="font-mono"
					id={id}
					readOnly
					ref={field}
					spellCheck={false}
					value={value}
				/>
				<Button
					aria-label={tl("Copy {label}", { label })}
					onClick={copy}
					size="icon"
					variant="ghost"
				>
					<HugeiconsIcon className="size-4" icon={Copy01Icon} />
				</Button>
			</div>
			<div className="flex items-center justify-between gap-2">
				<p
					className="text-muted-foreground text-xs"
					id={`${id}-note`}
					role="status"
				>
					Copy it now. It is not shown again.
				</p>
				<Button onClick={onDone} size="sm" variant="ghost">
					Done
				</Button>
			</div>
		</div>
	);
}
