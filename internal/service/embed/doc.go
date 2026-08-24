// Package embed resolves link previews (Open Graph / Twitter Card
// metadata) for chat messages and proxies their images back to clients.
//
// Service.Enqueue is called from the hub's event loop and never blocks: it
// hands a Job to a pool of background workers, which resolve it through a
// three-tier cache (in-memory Cache → Postgres via types.EmbedStorage →
// network fetch, see Service.resolve), deduplicating concurrent network
// fetches for the same URL with internal/storage/single_flight. Once a
// worker has a result it calls back into the hub through the Broadcaster
// interface (set post-construction via SetBroadcaster, since the hub and
// this service reference each other) to deliver a message_embeds event —
// this is the only way results reach the client; Enqueue itself returns
// nothing.
//
// Outbound HTTP (Fetcher, in fetcher.go) is hardened against SSRF: dialing
// goes through a safe dialer (safedial.go) that resolves and validates
// every address — including each hop of a redirect — against a blocklist
// of private/loopback/link-local ranges before connecting, so a malicious
// or compromised page can't be used to reach internal services.
//
// Handler (routes.go) serves the image proxy endpoint the client's <img>
// tags point at; it is intentionally unauthenticated (an <img src> can't
// send an Authorization header, and a query-string token would leak into
// Referer and logs) and relies instead on the image only being reachable
// via an unguessable per-preview token already recorded in link_previews.
package embed
