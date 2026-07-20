const WS_URL = "ws://127.0.0.1:7980/ws";
const RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;

export class RyuWebSocket {
	private ws: WebSocket | null = null;
	private reconnectAttempts = 0;
	private shouldReconnect = true;

	connect(onMessage: (data: unknown) => void): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			return;
		}

		this.ws = new WebSocket(WS_URL);

		this.ws.onopen = () => {
			this.reconnectAttempts = 0;
		};

		this.ws.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data);
				onMessage(data);
			} catch {
				onMessage(event.data);
			}
		};

		this.ws.onclose = () => {
			if (this.shouldReconnect) {
				this.scheduleReconnect(onMessage);
			}
		};

		this.ws.onerror = () => {
			this.ws?.close();
		};
	}

	private scheduleReconnect(onMessage: (data: unknown) => void): void {
		const delay = Math.min(
			RECONNECT_DELAY * 2 ** this.reconnectAttempts,
			MAX_RECONNECT_DELAY
		);
		this.reconnectAttempts++;
		setTimeout(() => this.connect(onMessage), delay);
	}

	disconnect(): void {
		this.shouldReconnect = false;
		this.ws?.close();
		this.ws = null;
	}

	send(data: unknown): void {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify(data));
		}
	}
}
