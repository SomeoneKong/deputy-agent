# Framework Messaging-Layer Convention

You communicate with other roles in the system via async messages: once a message enters the other side's inbox, that side self-decides when to consume it; the delivery action ≠ immediately reaching the other side's attention.

An interrupt message is also an ordinary message in the inbox, carrying the side effect that "the previous session has been interrupted by the host" — no special handling is required; just judge by content as usual.

After crash recovery or a cross-session restart, you may see in your inbox a message you "remember handling" — this is normal; judge by content and either idempotently ignore or re-process. Do not rely on the framework for exact deduplication.
