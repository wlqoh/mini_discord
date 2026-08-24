// Package sfu implements the SFU (Selective Forwarding Unit) voice/video
// transport described in sfu-migration-plan.md. It is embedded in the same
// process as internal/service/server (decision #2 in that plan: a monolith,
// not a separate service) but MUST NOT import that package — all
// interaction happens through the Signaler/Authorizer interfaces below,
// which internal/service/server.Hub implements. This keeps the media code
// isolated: a panic inside an RTP-reading goroutine is recovered locally
// (see sfu-migration-plan.md §8 pitfall #5) instead of being able to import
// and directly corrupt hub state, and the package can be lifted into a
// separate binary later (§10 of the plan) by adding a transport, not by
// untangling imports.
//
// Phase 0 only establishes this boundary; Router is unimplemented until
// migration phase 1.
package sfu
