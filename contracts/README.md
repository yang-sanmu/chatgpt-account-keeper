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
`src/agent/methodContracts.js` is the single method-to-definition map used by
both the Node runtime validator and the TypeScript generator. The method schema
keeps all 53 parameter/result definitions; the main schema additionally closes
the event payloads whose field drift has been observed in production while
leaving the remaining event payloads forward-compatible.

The Tauri client types are generated and checked with:

```sh
npm run ipc:generate
npm run ipc:check
```

Do not edit `app/src/ipc/generated.ts` by hand. CI runs `ipc:check` and fails if
the committed output differs from the schemas or method map. The Node dispatcher
also validates incoming parameters, outgoing method results, and outgoing event
envelopes at runtime. Changes require contract tests and a protocol minor/major
compatibility review.
