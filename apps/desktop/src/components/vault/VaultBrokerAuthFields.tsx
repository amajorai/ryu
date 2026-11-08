// The credential part of the broker service editor: the auth scheme and the
// references it injects. Every field takes a reference (`secret:NAME`,
// `op://…`, `bws://…`), never a value.

import { Input } from "@ryu/ui/components/input.tsx";
import { Label } from "@ryu/ui/components/label.tsx";
import {
	NativeSelect,
	NativeSelectOption,
} from "@ryu/ui/components/native-select.tsx";
import { Textarea } from "@ryu/ui/components/textarea.tsx";
import type { VaultBrokerAuthType } from "@/src/lib/api/vault-broker.ts";
import {
	type BrokerServiceForm,
	EDITABLE_AUTH_TYPES,
} from "./vault-broker-service-form.ts";

type RefField =
	| "header"
	| "password"
	| "prefix"
	| "token"
	| "username"
	| "value";

const FIELDS: Record<
	VaultBrokerAuthType,
	{ field: RefField; label: string; placeholder: string }[]
> = {
	api_key: [
		{ field: "header", label: "Header", placeholder: "x-api-key" },
		{ field: "value", label: "Key reference", placeholder: "secret:API_KEY" },
		{ field: "prefix", label: "Value prefix (optional)", placeholder: "" },
	],
	basic: [
		{
			field: "username",
			label: "Username",
			placeholder: "user or secret:USER",
		},
		{
			field: "password",
			label: "Password reference",
			placeholder: "secret:PASSWORD",
		},
	],
	bearer: [
		{
			field: "token",
			label: "Token reference",
			placeholder: "secret:API_TOKEN",
		},
	],
	custom: [],
	oauth: [],
	passthrough: [],
};

function isAuthType(value: string): value is VaultBrokerAuthType {
	return value in FIELDS;
}

export function BrokerAuthFields({
	form,
	onChange,
}: {
	form: BrokerServiceForm;
	onChange: (patch: Partial<BrokerServiceForm>) => void;
}) {
	const oauth = form.authType === "oauth";
	return (
		<div className="space-y-3">
			<div className="space-y-1.5">
				<Label htmlFor="broker-service-auth">Credential</Label>
				<NativeSelect
					className="w-full"
					disabled={oauth}
					id="broker-service-auth"
					onChange={(event) => {
						const next = event.target.value;
						if (isAuthType(next)) {
							onChange({ authType: next });
						}
					}}
					value={form.authType}
				>
					{oauth ? (
						<NativeSelectOption value="oauth">
							OAuth connection (kept as is)
						</NativeSelectOption>
					) : null}
					{EDITABLE_AUTH_TYPES.map((item) => (
						<NativeSelectOption key={item.value} value={item.value}>
							{item.label}
						</NativeSelectOption>
					))}
				</NativeSelect>
			</div>
			{FIELDS[form.authType].map((item) => (
				<div className="space-y-1.5" key={item.field}>
					<Label htmlFor={`broker-service-${item.field}`}>{item.label}</Label>
					<Input
						autoComplete="off"
						className="font-mono"
						id={`broker-service-${item.field}`}
						onChange={(event) => onChange({ [item.field]: event.target.value })}
						placeholder={item.placeholder}
						spellCheck={false}
						value={form[item.field]}
					/>
				</div>
			))}
			{form.authType === "custom" ? (
				<div className="space-y-1.5">
					<Label htmlFor="broker-service-headers">Headers</Label>
					<Textarea
						autoComplete="off"
						className="min-h-24"
						id="broker-service-headers"
						onChange={(event) =>
							onChange({ customHeaders: event.target.value })
						}
						placeholder="Authorization: Token {{secret:API_TOKEN}}"
						spellCheck={false}
						value={form.customHeaders}
						variant="code-caption"
					/>
				</div>
			) : null}
		</div>
	);
}
