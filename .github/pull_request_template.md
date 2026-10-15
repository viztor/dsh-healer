<!--
Keep this short. A reviewer needs to know what changed and how you know it works.
-->

## What changed

<!-- One or two sentences. If it fixes a defect, say what the defect was. -->

## Why

<!--
The reasoning, not the diff. A diff already shows *what*; this is for *why this
shape* and what else you considered.
-->

## How it was verified

<!--
`pnpm run ci` covers the typechecks, the suite and the upstream verifier, and
`pnpm run test:mutation` covers the mutation gate. Say what else you ran, and
anything you deliberately did not.
-->

- [ ] `pnpm run ci` passes
- [ ] `pnpm run test:mutation` reports 46/46 caught
- [ ] New behaviour has a test that fails without the change

## Notes for the reviewer

<!--
Anything surprising: a deliberate divergence, a known limitation, a follow-up
you are not doing here. "Nothing" is a fine answer.
-->
