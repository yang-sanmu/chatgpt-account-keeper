# Keeper IPC contracts

`ipc-v1.schema.json` is the canonical wire contract between the native desktop
client and the per-user Node agent. The transport is a 4-byte little-endian
payload length followed by one UTF-8 JSON document. Frames larger than 8 MiB
must be rejected before allocating their payload buffer.

Compatibility rules:

- A different protocol major version is incompatible.
- Minor versions may only add optional fields, methods, events or capabilities.
- v1.4 adds `environments.get/update/reset` and `network.getCapabilities`. Existing DTOs and events are unchanged. Desktop and Agent ship together: old clients may connect to the new Agent; a 1.4 Desktop refuses an older Agent and requests a paired upgrade. Strict network capabilities remain unavailable pending M1 acceptance; the remaining v3 network interfaces are not yet implemented.
- v1.5 adds `network.getConfig/updateConfig` and an optional `proxies.network` snapshot for ordinary direct, system-proxy, and relay modes. The paired Desktop requires Agent 1.5; strict network isolation remains unavailable. Database schema 8 persists the network configuration and backs up older databases before upgrade.
- v1.6 adds `temporaryWindows.list/save/open/close/remove/clearData/detectRegion`, the optional `bootstrap.temporaryWindows` snapshot and `temporaryWindows.changed` event. Independent windows bind a proxy node directly, retain their profiles on close, and participate in browser ownership and update blockers. Schema 9 adds their configurations and protects proxy references. The paired Desktop requires Agent 1.6.
- Mutating requests carry a UUID `commandId` and are idempotent.
- The first request on every connection is `system.hello`.
- A changed `instanceId` or a gap in event `seq` requires `system.bootstrap`.
- Secrets such as proxy subscription URLs, credentials, cookies and profile
  content must never be returned by the agent.

`ipc-v1.schema.json` defines the stable envelopes and shared types.
`ipc-v1.methods.schema.json` defines every method's parameter and result shape.
`src/agent/methodContracts.js` is the single method-to-definition map used by
both the Node runtime validator and the TypeScript generator. The method schema
keeps all 67 parameter/result definitions; the main schema additionally closes
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
