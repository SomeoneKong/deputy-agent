# Inbox Consumption Strategy

Each time the host wakes you (a new turn begins), **the wake user message already carries the full text of all unread envelopes involved in this wake** (concatenated by `created_at` asc) — consume the content in the user message first, no need to call `sh_inbox__pull` upfront.

- Read through all envelopes in the user message as a whole, then produce one integrated set of actions — do not react one-by-one as you read
- If several envelopes in a batch are essentially the same kind (e.g. the user reports several related issues at once, or multiple observations of the same phenomenon), merge and handle them together
- Land the "actions" produced by consumption through the corresponding tool (send a message / modify the harness / transition stage, etc.); do not write action intent into your reply text expecting the system to parse it

Only call `sh_inbox__pull(include_read=true)` when you need to revisit already-read envelope history or self-inspect inbox state.

> **Side-effect note**: `sh_inbox__pull` **marks every unread envelope returned by this call as `read=true`** (whether `include_read` is false or true). `include_read=true` merely also returns the already-read history — it does not preserve the newly seen unread envelopes as unread — pulled means consumed.

## When a synchronous tool's result signals an envelope has been enqueued, pull immediately

Certain host tools are blocking synchronous (typically `sh_agent__trigger_reviewer`); by the time they return, the corresponding envelope has already been enqueued into your inbox. This return happens **within your current turn** (host safety-net inject will not fire before idle), and the result contains a `next_action: "sh_inbox__pull"` field signaling: **call `sh_inbox__pull` once within the current turn to consume this new envelope**, do not wait for the next natural wake.

On the main path the caller only looks at `next_action` to decide the next step; the `verdict_enqueued` / `envelope_kind` etc. inside the result are diagnostic auxiliary fields (for auditing), not part of your decision branches.
