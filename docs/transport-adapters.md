# Transport adapters

The package's "zero runtime dependencies, ESM, strict" claim rests on
`package.json`'s `devDependencies` being only
`@types/node`/`typescript`/`vitest`. Bringing a delivery mechanism such as a
WebSocket client into the core package would break that, so the delivery
layer stays outside the core, in a separate package.

**There is no `TransportAdapter` type.** `onTrace` (`src/trace.ts`) and
`describePipe`/`projectWiringGraph` (`src/wiring-graph.ts`) are public
exports of `index.ts`, and those two APIs are all an external package needs
to assemble delivery. Freezing a concrete delivery shape (WS send, etc.)
into a type here would take that design freedom away from the bridge package
that actually builds one.

```ts
// tests/transport-adapter.test.ts — uses only index.ts's public exports,
// modeling how an external bridge package would consume them
const kernel = builder.build({
  tracing: true,
  onTrace: (symbolId, verb, span, payload, timestamp) =>
    send({ symbolId, verb, span, payload, timestamp }), // live path
});

const doc = projectWiringGraph(catalog, builder.boundSymbolIds);
send(doc); // static path — both flow into the same send()
```

That this stays dev-only is guaranteed by the opt-in design itself — nothing
happens unless the consumer explicitly wires `onTrace`/catalog emission
(close to Redux's `window.__REDUX_DEVTOOLS_EXTENSION__` pattern; no reliance
on build-time dead-code elimination). `tests/transport-adapter.test.ts`
verifies that both paths (live trace, static catalog) can be assembled from
`../src/index.js` imports alone, never touching internal modules like
`src/kernel.ts`/`src/trace.ts`. Note this proves the completeness of the
public export surface as seen from within this repository; consuming the
built `dist/` output through a real package boundary is an external
package's own verification.
