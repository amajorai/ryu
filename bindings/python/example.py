"""No-network Python SDK example.

Build the generated binding first, then run ``PYTHONPATH=. python example.py``
from this directory. A model request is intentionally not sent here; it only
shows the shared validation and Gateway-only client construction.
"""

import ryu_sdk


def main() -> None:
    ryu_sdk.validate_plugin_id("com.example.python")
    ryu_sdk.assert_allowed_egress("http://127.0.0.1:7981")
    model = ryu_sdk.ModelClient("gemma4", "http://127.0.0.1:7981", None)
    print("Ryu Python SDK example ready:", ryu_sdk.resolve_gateway_url())
    del model


if __name__ == "__main__":
    main()
