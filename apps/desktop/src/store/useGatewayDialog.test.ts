import { afterEach, describe, expect, test } from "bun:test";
import { useProductModeStore } from "@/src/lib/product-mode.ts";
import { useGatewayDialog } from "./useGatewayDialog.ts";

const initialProductMode = useProductModeStore.getState();

function resetGatewayDialog(): void {
	useGatewayDialog.setState({ open: false, section: "overview" });
}

afterEach(() => {
	useProductModeStore.setState({
		consoleAccess: initialProductMode.consoleAccess,
		requestedMode: initialProductMode.requestedMode,
	});
	resetGatewayDialog();
});

describe("useGatewayDialog.openGateway", () => {
	test("opens at the requested section in Console", () => {
		resetGatewayDialog();
		useProductModeStore.setState({
			consoleAccess: true,
			requestedMode: "console",
		});

		useGatewayDialog.getState().openGateway("audit");

		expect(useGatewayDialog.getState()).toMatchObject({
			open: true,
			section: "audit",
		});
	});

	test("does nothing in Bot, in OS, or while Console access is unresolved", () => {
		for (const state of [
			{ consoleAccess: true, requestedMode: "bot" },
			{ consoleAccess: true, requestedMode: "os" },
			{ consoleAccess: false, requestedMode: "console" },
		] as const) {
			resetGatewayDialog();
			useProductModeStore.setState(state);

			useGatewayDialog.getState().openGateway("routing");

			expect(useGatewayDialog.getState()).toMatchObject({
				open: false,
				section: "overview",
			});
		}
	});

	test("a refused request is not queued for the next switch to Console", () => {
		resetGatewayDialog();
		useProductModeStore.setState({ consoleAccess: true, requestedMode: "os" });
		useGatewayDialog.getState().openGateway("keys");

		useProductModeStore.setState({ requestedMode: "console" });

		expect(useGatewayDialog.getState().open).toBe(false);
	});
});
