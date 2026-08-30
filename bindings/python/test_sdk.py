"""Contract tests for the generated Python binding.

The generated module is built by the UniFFI test workflow before this file runs.
These tests deliberately avoid a live Gateway: they exercise the shared kernel's
validation and construction boundaries, while the Rust SDK tests cover the HTTP
wire round trips.
"""

import json
import unittest

import ryu_sdk


VALID_MANIFEST = (
    '{"id":"com.example.x","name":"X","version":"1.0.0",'
    '"runnables":[{"id":"t","name":"T","kind":"tool",'
    '"config":{"slug":"s"}}]}'
)


class RyuSdkBindingTests(unittest.TestCase):
    def test_manifest_surface_uses_shared_validation(self) -> None:
        ryu_sdk.validate_plugin_id("io.ryu.ok")
        with self.assertRaises(ryu_sdk.RyuError):
            ryu_sdk.validate_plugin_id("../evil")

        normalized = ryu_sdk.parse_and_validate_manifest(VALID_MANIFEST)
        self.assertEqual(json.loads(normalized)["id"], "com.example.x")
        with self.assertRaises(ryu_sdk.RyuError):
            ryu_sdk.parse_and_validate_manifest(VALID_MANIFEST.replace("1.0.0", "nope"))

        schema = json.loads(ryu_sdk.plugin_manifest_json_schema())
        self.assertIn("properties", schema)

    def test_gateway_egress_and_client_construction(self) -> None:
        ryu_sdk.assert_allowed_egress("http://127.0.0.1:7981")
        with self.assertRaises(ryu_sdk.RyuError):
            ryu_sdk.assert_allowed_egress("https://api.openai.com")

        with self.assertRaises(ryu_sdk.RyuError):
            ryu_sdk.ModelClient("gpt-4o", "https://api.openai.com", None)

        model = ryu_sdk.ModelClient("gemma4", "http://127.0.0.1:7981", None)
        self.assertTrue(callable(model.chat))
        self.assertTrue(callable(model.stream))

        embedder = ryu_sdk.EmbeddingClient(
            "nomic-embed-text-v1.5", "http://127.0.0.1:7981", None
        )
        self.assertTrue(callable(embedder.embed))


if __name__ == "__main__":
    unittest.main()
