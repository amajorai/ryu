import CheckoutSuccess from "@ryu/blocks/web/checkout-success.tsx";
import { Button } from "@ryu/ui/components/button.tsx";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { GiftSettlement } from "../../../web/src/app/success/gift-settlement.tsx";
import "../../../web/src/index.css";
function Story() {
	const [checkout, setCheckout] = useState("fixture-checkout-a");
	const [mounted, setMounted] = useState(true);
	return (
		<main className="min-h-screen bg-background text-foreground">
			<div className="flex gap-2 p-4">
				<Button onClick={() => setCheckout("fixture-checkout-b")}>
					Switch fixture checkout
				</Button>
				<Button onClick={() => setMounted(!mounted)}>
					{mounted ? "Unmount status" : "Mount status"}
				</Button>
			</div>
			{mounted ? <GiftSettlement checkoutId={checkout} /> : null}
			<CheckoutSuccess checkoutId={checkout} />
		</main>
	);
}
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(<Story />);
}
