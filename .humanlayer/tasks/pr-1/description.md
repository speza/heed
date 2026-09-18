## Why the change

Heed needs to aggregate terminal-based and API-based agent sessions without making terminal ownership a universal assumption.

## Special things to note

- Herdr remains the first real adapter; Amp, direct API authentication, and structured conversation are deliberately deferred.
- The Mock API adapter is synthetic and opt-in via `HEED_ENABLE_MOCK_RUNTIME=1`, so normal live mode remains Herdr-only.
- Live Agent IDs are now source-namespaced (for example, `herdr-local:<pane>`); Heed does not currently persist selections.

## Change outline

Runtime contract and adapter ownership:

```typescript
RuntimeSnapshot
├── sources: RuntimeSource[]
└── agents: RuntimeAgent[]
    ├── source: RuntimeSource
    ├── location?: RuntimeLocation
    └── capabilities: RuntimeCapabilities
        ├── terminal
        ├── output
        ├── conversation
        ├── workspaceChanges
        ├── spawn
        └── lineage
```

Runtime gateway flow:

```text
GET /api/runtime
  RuntimeGateway.snapshot()
    ├── HerdrRuntimeAdapter.snapshot()
    ├── MockApiRuntimeAdapter.snapshot()  [opt-in]
    └── aggregate available agents and sources

POST /api/runtime/agents/:id/terminal
  resolve source-namespaced Agent ID
  if adapter lacks openTerminal -> 409 capability response
  otherwise delegate to the owning adapter
```

Changed responsibilities:

```text
server/
├── runtime-gateway.ts       # adapter contract, aggregation, HTTP routing
├── runtime-config.ts        # configured adapter registry
├── herdr.ts                 # Herdr adapter and Herdr-specific operations
├── mock-runtime.ts          # opt-in non-terminal synthetic adapter
└── runtime-gateway.test.ts  # aggregation and capability coverage

src/runtime/
├── types.ts                 # source, location, and capability contract
├── map.ts                   # normalized runtime-to-UI mapping
└── map.test.ts              # Herdr and non-terminal mapping coverage
```

UI and native control flow:

```diff
 <App>
   <FleetView>
+    show each runtime source
   <FocusList>
+    render only the location fields a source exposes
-  <TerminalCard> for every live Agent
+  <TerminalCard> only when capabilities.terminal
-  Workspace changes for every live Agent
+  Workspace changes only when capabilities.workspaceChanges

 showPanel
+  focusPanel()
+    activate app
+    order window front
+    make panel key
+    make WebKit first responder
   animate reveal
+  completion -> focusPanel()  // reassert focus after global hotkey activation
```
