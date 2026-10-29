// Exact owned boot-sync preference wire contracts, not a generic success route.
export function createVersionEntitlementPreferences() {
	const values = {
		a: {
			"entitlement-active": null as string | null,
			"managed-inference-entitled": null as string | null,
		},
		b: {
			"entitlement-active": null as string | null,
			"managed-inference-entitled": null as string | null,
		},
	};
	return {
		snapshot: (key: "entitlement-active" | "managed-inference-entitled") => ({
			a: values.a[key],
			b: values.b[key],
		}),
		handle(scope: "a" | "b", method: string, path: string, body: unknown) {
			const key =
				path === "/api/preferences/entitlement-active"
					? "entitlement-active"
					: path === "/api/preferences/managed-inference-entitled"
						? "managed-inference-entitled"
						: null;
			if (!key) return null;
			if (method === "GET")
				return { status: 200, body: { key, value: values[scope][key] } };
			if (method !== "PUT") return null;
			if (
				!body ||
				typeof body !== "object" ||
				Object.keys(body).length !== 1 ||
				!Object.hasOwn(body, "value") ||
				!["true", "false"].includes(
					String((body as { value: unknown }).value),
				) ||
				typeof (body as { value: unknown }).value !== "string"
			)
				return {
					status: 400,
					body: { error: "Invalid owned entitlement preference DTO" },
				};
			values[scope][key] = (body as { value: string }).value;
			return { status: 200, body: { key, value: values[scope][key] } };
		},
	};
}
