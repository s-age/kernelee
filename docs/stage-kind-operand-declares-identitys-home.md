# StageKind: the operand declares where a stage's identity lives

`StageKind` is a compound literal, `method(operand)`. The method part names
the causal kind a stage brings to the pipe (control / value / side effect /
fan-out); **the operand names the channel the stage's identity lives in** —
never how the stage merely happened to be written:

- `(symbol)` — routed through `kernel.invoke` (traceable, joinable); identity
  is `symbolId`.
- `(function)` — runs the author's function directly, but it was passed *by
  name*; identity is `handlerName`.
- `(closure)` — runs directly with **no identity at all**; the author's
  `note` (prose) is the only label, which is why `pipe(closure)`'s note is
  required while the `(function)` variants' stays optional.
- `(branches)` — fork's fan-out.

`(function)` vs `(closure)` is minted from the SAME `fn.name` check that
fills `handlerName`, evaluated once — kind and field can never disagree.
Payload assembly is its own visible `.map(adapt)` node rather than a hidden
second argument on `.pipe`/`.tap`, so a value change is a graph node. A
corollary invariant: **arity never carries kind information** — operand
*type* tells the overloads apart.

## Gotchas

- **`.map(project).tap(sym)` does not "adapt the tap"**: map REPLACES the
  cursor with the projection, and tap forwards whatever cursor it saw. When
  the tapped symbol can't take the cursor as-is, reshape the symbol's input
  or `fork` and let the untouched payload ride its own branch.
- One static/runtime split to keep aligned: an inline **named function
  expression** (`.map(function join() {…})`) has a non-empty `fn.name`, so
  the runtime mints `(function)`; a static scanner classifying "inline =
  closure" would disagree.
- Author-declared channels are exactly two: `note` (prose) and `divertsTo`
  (edges). Everything else is machine-derived — resist adding prose fields
  or mandatory notes; note PRESENCE on optional kinds is itself the signal.
