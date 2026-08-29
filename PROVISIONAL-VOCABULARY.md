# PROVISIONAL-VOCABULARY.md

Two files in `packages/contracts` are stand-ins with a known expiry date:

| File | Stands in for | Owner of the real thing |
|---|---|---|
| `src/rule-document.provisional.ts` | `types.ts` in the lifted plugin-builder | Engineer 3 |
| `src/validation.provisional.ts` | `validation.ts` in the lifted plugin-builder | Engineer 3 |

## Why they exist

The real rule vocabulary lives in `farlands-app/src/lib/plugin-builder/types.ts` in the private
baseline repository. It is the agent action space and the capability ceiling, and it is the first
of the four `[CONFIRM]` files for exactly that reason. Nothing downstream can be designed properly
without it.

It is also not in hand yet. Waiting for it would idle the authoring pipeline, the MCP server, the
CLI and the mock API, all of which need *a* vocabulary to be built against, not *the* vocabulary.

So these two files exist to be deleted. They are deliberately small, deliberately boring, and they
carry the two properties the real vocabulary has that actually shape downstream code:

1. **Every primitive is stateless.** A backend transfer preserves the player connection but not
   in-memory plugin state, so nothing may require the plugin to remember anything between ticks.
2. **Shape validity is not semantic validity.** A document can satisfy every type and still be
   rejected, for example by naming a region the server has not defined. The repair loop is built
   around that distinction, so the stand-in has to have it too.

## What must not happen

**Do not add primitives here to make a feature work.** Widening the vocabulary is a security
change, reviewed one primitive at a time against the real file. A primitive added to the stand-in
is a primitive nobody reviewed, and it will be silently dropped at swap time, taking whatever was
built on it with it.

**Do not port the real `validation.ts` into TypeBox.** It arrives reviewed. Re-deriving it by hand
is how a safety property gets lost without anyone noticing. `packages/contracts` references the
rule document type across the seam; it does not reimplement it.

**Do not add a bypass.** There is no trusted-caller flag in the stand-in and there is none in the
real validator either. A document that fails validation does not exist as far as the rest of the
system is concerned.

## The swap, at Phase 0

1. Engineer 3 lifts `packages/plugin-builder` wholesale, all nine files, unrestructured.
2. Delete `src/rule-document.provisional.ts` and `src/validation.provisional.ts`.
3. Delete the two `provisionalVocabulary` and `provisionalValidation` exports from
   `src/index.ts`.
4. Re-export the real rule document type from `packages/plugin-builder` so consumers keep one
   import path.
5. Run `rg provisional` across the repository. Every remaining hit is a consumer that needs
   repointing. This is why the exports are namespaced rather than flattened: the grep is the
   migration checklist.
6. Regenerate schemas (`bun run schemas`) and re-run the fixture suite.

## What the swap will break, and that is fine

The fixtures under `fixtures/rules/` are written against the stand-in vocabulary. When the real one
lands they will need rewriting against the real primitives. That is expected work, not a problem
with the approach: the fixture *contract* (a valid set covering every primitive, an invalid set
with expected error codes, a test asserting both) survives the swap even though the fixture
*contents* do not.

The authoring repair loop should not need to change at all. It is built against the call shape
`validateRuleDocument(document, context)` and a result union, both of which the real validator is
expected to match. If it does not, adapt at that one boundary rather than reshaping the loop.
