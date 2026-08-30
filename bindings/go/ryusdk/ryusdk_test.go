package ryusdk

import (
	"encoding/json"
	"strings"
	"testing"
)

const validManifest = `{"id":"com.example.x","name":"X","version":"1.0.0","runnables":[{"id":"t","name":"T","kind":"tool","config":{"slug":"s"}}]}`

func TestManifestValidationUsesSharedKernel(t *testing.T) {
	if err := ValidatePluginID("io.ryu.ok"); err != nil {
		t.Fatalf("valid plugin id rejected: %v", err)
	}
	if err := ValidatePluginID("../evil"); err == nil {
		t.Fatal("path traversal plugin id was accepted")
	}

	normalized, err := ParseAndValidateManifest(validManifest)
	if err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal([]byte(normalized), &manifest); err != nil {
		t.Fatalf("normalized manifest is not JSON: %v", err)
	}
	if manifest["id"] != "com.example.x" {
		t.Fatalf("normalized manifest lost its id: %v", manifest["id"])
	}
	if _, err := ParseAndValidateManifest(strings.Replace(validManifest, "1.0.0", "nope", 1)); err == nil {
		t.Fatal("invalid semver was accepted")
	}
	if schema := PluginManifestJSONSchema(); !strings.Contains(schema, "\"properties\"") {
		t.Fatal("manifest schema did not contain properties")
	}
}

func TestGatewayEgressAndModelLifecycle(t *testing.T) {
	if err := AssertAllowedEgress("http://127.0.0.1:7981"); err != nil {
		t.Fatalf("loopback gateway was blocked: %v", err)
	}
	if err := AssertAllowedEgress("https://api.openai.com"); err == nil {
		t.Fatal("direct provider egress was allowed")
	}

	if _, err := NewModelClient("gpt-4o", "https://api.openai.com", ""); err == nil {
		t.Fatal("model client accepted a direct provider")
	}
	client, err := NewModelClient("gemma4", "http://127.0.0.1:7981", "")
	if err != nil {
		t.Fatalf("gateway model client rejected: %v", err)
	}
	client.Close()
	client.Close()
	if _, err := client.Chat(`[]`); err == nil {
		t.Fatal("closed model client accepted a chat")
	}
}

func TestEmbeddingLifecycle(t *testing.T) {
	if _, err := NewEmbeddingClient("text-embedding-3-small", "https://api.openai.com", ""); err == nil {
		t.Fatal("embedding client accepted a direct provider")
	}
	client, err := NewEmbeddingClient("nomic-embed-text-v1.5", "http://127.0.0.1:7981", "")
	if err != nil {
		t.Fatalf("gateway embedding client rejected: %v", err)
	}
	defer client.Close()
	if _, err := client.Embed("not json"); err == nil {
		t.Fatal("invalid embedding JSON was accepted")
	}
}
