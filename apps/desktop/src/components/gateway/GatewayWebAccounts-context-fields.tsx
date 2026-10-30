import { useLiteralMessages } from "@ryu/i18n/react";
import { Checkbox } from "@ryu/ui/components/checkbox.tsx";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@ryu/ui/components/field.tsx";
import { Input } from "@ryu/ui/components/input.tsx";
import { useId } from "react";
import type {
	GatewayWebConnection,
	GatewayWebContext,
	GatewayWebProvider,
} from "@/src/lib/api/web-service-accounts.ts";

export function defaultContext(
	provider: GatewayWebProvider
): GatewayWebContext {
	if (provider === "google-pse") {
		return {
			kind: "google_pse",
			engine_id: "",
			existing_customer_acknowledged: false,
		};
	}
	if (provider === "searchapi") {
		return { kind: "search_api", engine: "google" };
	}
	return { kind: "default" };
}
export function validContext(context: GatewayWebContext): boolean {
	return (
		context.kind !== "google_pse" ||
		(context.engine_id.trim().length > 0 && context.engine_id.length <= 256)
	);
}
export function emptyConnection(
	provider: GatewayWebProvider
): GatewayWebConnection {
	return { provider, anonymous: false, accounts: [] };
}

export function ContextFields({
	context,
	label,
	disabled,
	onChange,
}: {
	context: GatewayWebContext;
	label: string;
	disabled: boolean;
	onChange: (context: GatewayWebContext) => void;
}) {
	const fieldId = useId();
	const tl = useLiteralMessages();
	if (context.kind === "default") {
		return null;
	}
	if (context.kind === "search_api") {
		return (
			<Field>
				<FieldLabel htmlFor={fieldId}>Search engine</FieldLabel>
				<Input
					aria-label={tl("{label} search engine", { label })}
					id={fieldId}
					readOnly
					value="Google"
				/>
				<FieldDescription>
					This connection uses the Google engine.
				</FieldDescription>
			</Field>
		);
	}
	return (
		<FieldGroup>
			<Field data-invalid={!validContext(context)}>
				<FieldLabel htmlFor={`${fieldId}-engine`}>Search engine ID</FieldLabel>
				<Input
					aria-invalid={!validContext(context)}
					aria-label={tl("{label} search engine ID", { label })}
					autoComplete="off"
					disabled={disabled}
					id={`${fieldId}-engine`}
					maxLength={256}
					onChange={(event) =>
						onChange({ ...context, engine_id: event.target.value })
					}
					value={context.engine_id}
				/>
				<FieldDescription>
					Each key and engine combination has its own account identity.
				</FieldDescription>
			</Field>
			<Field data-disabled={disabled} orientation="horizontal">
				<Checkbox
					aria-label={tl("{label} existing customer confirmation", { label })}
					checked={context.existing_customer_acknowledged}
					disabled={disabled}
					id={`${fieldId}-customer`}
					onCheckedChange={(checked) =>
						onChange({ ...context, existing_customer_acknowledged: checked })
					}
				/>
				<FieldLabel htmlFor={`${fieldId}-customer`}>
					<span className="sr-only">
						{tl("{label} existing customer confirmation", { label })}
					</span>
					<span aria-hidden="true">
						Existing Custom Search JSON API customer
					</span>
				</FieldLabel>
			</Field>
			<FieldDescription>
				New customers cannot use this API. Unconfirmed accounts stay inactive.
				Existing access ends January 1, 2027.
			</FieldDescription>
		</FieldGroup>
	);
}
