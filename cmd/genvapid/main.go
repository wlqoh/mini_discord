// genvapid prints a fresh VAPID key pair for the push.vapid_public_key /
// push.vapid_private_key config fields. Run once per environment and paste
// the output into config/local.yaml (or the prod config) — see Readme.md.
package main

import (
	"fmt"
	"log"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func main() {
	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		log.Fatalf("failed to generate VAPID keys: %s", err)
	}

	fmt.Println("vapid_public_key:", publicKey)
	fmt.Println("vapid_private_key:", privateKey)
}
