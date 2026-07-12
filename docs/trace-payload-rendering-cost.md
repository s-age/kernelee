# Trace payload rendering is a per-invoke hot path

## Gotcha: the 1024-character cap only applies *after* stringify

`describeTracePayload`'s `PAYLOAD_CAP` slices the *string*, after
serialization. A TypedArray has no `toJSON`, so `JSON.stringify` enumerates
every numeric key, and the pre-cap cost stays O(elements) — paid on **every
invoke** while tracing is on. In an app where fork multiplies invoke counts
(e.g. 3072 invokes per generation at cell granularity), that becomes
"payload size × invoke count": ~0.13 ms per render × 3072 ≈ 400 ms per
generation spent on trace rendering alone — large enough for a devtools
rendering cost to masquerade as an app-level performance bug.

## The replacer runs *before* descent — which is what makes O(1) possible

`JSON.stringify(payload, replacer)` calls the replacer before serialization
descends into a value. Returning `"Uint8Array(3072)"` for an ArrayBuffer
view means the per-element walk never starts. `constructor.name + length` is
the honest rendering of facts the runtime already holds in its hand — not a
new vocabulary and not an escape hatch.

## Lazy rendering (passing a thunk) was rejected

Deferring payload rendering to the sink was considered and rejected:

- (a) The motivation disappears once binary views are summarized (the
  residual cost is µs-order).
- (b) Eager stringify is a snapshot at call time — deferral either risks
  rendering a payload that was mutated after the invoke (a lie), or brings
  in a defensive copy costlier than the stringify.
- (c) `TraceSink`'s payload would no longer be plain data (a string),
  breaking the serialization boundary any bridge relies on.

Revisit trigger: a symbol that carries huge payloads that are *not* binary —
and even then, extend the summarizer before reaching for deferral.
