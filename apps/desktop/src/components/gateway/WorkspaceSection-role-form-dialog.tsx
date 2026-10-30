import { useLiteralMessages } from "@ryu/i18n/react";
import { Button } from "@ryu/ui/components/button.tsx";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@ryu/ui/components/dialog.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import type { ReactElement } from "react";
import { useState } from "react";
import { PERMISSIONS } from "@/src/lib/api/org.ts";

/** A short kebab-case key (letters, digits, single dashes) unique per org. */
const KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RoleFormValues {
	key: string;
	name: string;
	permissions: string[];
}

/**
 * Create / edit dialog for a custom role. In create mode the key is editable and
 * kebab-validated; in edit mode the key is fixed (it identifies the role and its
 * assignments) so only the name and permission set change. The permission grid is
 * the literal "checkbox per PERMISSIONS key" matrix for the role being authored.
 */
export function RoleFormDialog({
	trigger,
	mode,
	initial,
	onSubmit,
}: {
	trigger: ReactElement;
	mode: "create" | "edit";
	initial?: RoleFormValues;
	onSubmit: (values: RoleFormValues) => Promise<boolean>;
}) {
	const tl = useLiteralMessages();
	const empty: RoleFormValues = { key: "", name: "", permissions: [] };
	const [open, setOpen] = useState(false);
	const [values, setValues] = useState<RoleFormValues>(initial ?? empty);
	const [saving, setSaving] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const handleOpenChange = (next: boolean) => {
		if (!next && saving) {
			return;
		}
		if (next) {
			setValues(initial ?? empty);
			setErr(null);
		}
		setOpen(next);
	};

	const togglePermission = (perm: string, checked: boolean) => {
		setValues((v) => ({
			...v,
			permissions: checked
				? [...v.permissions, perm]
				: v.permissions.filter((p) => p !== perm),
		}));
	};

	const handleSubmit = async () => {
		const name = values.name.trim();
		const key = values.key.trim();
		if (!name) {
			setErr("Name is required.");
			return;
		}
		if (mode === "create" && !KEBAB_RE.test(key)) {
			setErr("Key must be kebab-case (letters, digits, single dashes).");
			return;
		}
		setSaving(true);
		setErr(null);
		try {
			const saved = await onSubmit({
				key,
				name,
				permissions: values.permissions,
			});
			if (saved === false) {
				return;
			}
			setOpen(false);
		} catch (e) {
			setErr(e instanceof Error ? e.message : "Failed to save role.");
		} finally {
			setSaving(false);
		}
	};

	return (
		<Dialog onOpenChange={handleOpenChange} open={open}>
			<DialogTrigger render={trigger} />
			<DialogContent showCloseButton={!saving}>
				<DialogHeader>
					<DialogTitle>
						{mode === "create"
							? "New custom role"
							: tl("Edit {name}", { name: values.name })}
					</DialogTitle>
					<DialogDescription>
						Grant a precise set of permissions. Members holding this role gain
						these permissions on top of their built-in tier.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-4 py-2">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="role-name">Name</Label>
						<Input
							disabled={saving}
							id="role-name"
							onChange={(e) =>
								setValues((v) => ({ ...v, name: e.target.value }))
							}
							placeholder="e.g. Workflow editor"
							value={values.name}
						/>
					</div>
					{mode === "create" ? (
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="role-key">Key</Label>
							<Input
								disabled={saving}
								id="role-key"
								onChange={(e) =>
									setValues((v) => ({ ...v, key: e.target.value }))
								}
								placeholder="e.g. workflow-editor"
								value={values.key}
							/>
							<p className="text-muted-foreground text-xs">
								Kebab-case, unique within this workspace. Cannot be changed
								later.
							</p>
						</div>
					) : null}
					<div className="flex flex-col gap-2">
						<Label>Permissions</Label>
						<div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
							{PERMISSIONS.map((perm) => (
								<label
									className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-muted/50"
									key={perm}
								>
									<Checkbox
										checked={values.permissions.includes(perm)}
										disabled={saving}
										onCheckedChange={(checked) =>
											togglePermission(perm, checked === true)
										}
									/>
									<span className="font-mono text-xs">{perm}</span>
								</label>
							))}
						</div>
					</div>
					{err ? (
						<p className="text-sm text-status-destructive">{err}</p>
					) : null}
				</div>
				<DialogFooter>
					<Button
						disabled={saving}
						onClick={() => setOpen(false)}
						variant="ghost"
					>
						Cancel
					</Button>
					<Button
						loading={saving}
						onClick={() => handleSubmit()}
						variant="outline"
					>
						{mode === "create" ? "Create role" : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
