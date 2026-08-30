package main

import (
	"fmt"
	"log"

	"github.com/amajorai/ryu/bindings/go/ryusdk"
)

func main() {
	if err := ryusdk.ValidatePluginID("com.example.go"); err != nil {
		log.Fatal(err)
	}
	if err := ryusdk.AssertAllowedEgress("https://api.openai.com"); err == nil {
		log.Fatal("direct provider egress was unexpectedly allowed")
	}
	model, err := ryusdk.NewModelClient("gemma4", ryusdk.ResolveGatewayURL(), "")
	if err != nil {
		log.Fatal(err)
	}
	defer model.Close()

	embeddings, err := ryusdk.NewEmbeddingClient("nomic-embed-text-v1.5", ryusdk.ResolveGatewayURL(), "")
	if err != nil {
		log.Fatal(err)
	}
	defer embeddings.Close()

	fmt.Println("Ryu Go SDK example ready:", ryusdk.ResolveGatewayURL())
}
