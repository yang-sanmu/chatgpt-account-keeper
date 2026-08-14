# Keeper IPC contracts

`ipc-v1.schema.json` is the canonical wire contract between the native desktop
client and the per-user Node agent. The transport is a 4-byte little-endian
payload length followed by one UTF-8 JSON document. Frames larger than 8 MiB
must be rejected before allocating their payload buffer.

Compatibility rules:

- A different protocol major version is incompatible.
- Minor versions may only add optional fields, methods, events or capabilities.
- Mutating requests carry a UUID `commandId` and are idempotent.
- The first request on every connection is `system.hello`.
- A changed `instanceId` or a gap in event `seq` requires `system.bootstrap`.
- Secrets such as proxy subscription URLs, credentials, cookies and profile
  content must never be returned by the agent.

`ipc-v1.schema.json` defines the stable envelopes and shared types.
`ipc-v1.methods.schema.json` defines every method's parameter and result shape.
The Node dispatcher validates both incoming parameters and outgoing results;
the desktop uses source-generated C# DTO metadata. Changes to either side
require protocol contract tests and a protocol minor/major compatibility review.
