---
name: ward
description: "Continue working on the current WDD Ward. Checks ward status and follows checkpoint discipline with mandatory human approval gates."
---

# /ward — Continue Current Ward

Run `wdd session` to find the current ward and its status, then follow the appropriate flow:

## planned — Start Red phase
1. Run `wdd ward status <id> red`
2. Write tests per the ward spec's Tests table
3. Present tests to user
4. ⏸️ **STOP — Wait for explicit approval. Do NOT proceed.**

## red — Tests written, awaiting approval
1. Present the tests if not yet shown
2. ⏸️ **STOP — Wait for explicit approval. Do NOT proceed.**

## approved — Start Gold phase
1. Run `wdd ward status <id> gold`
2. Implement until all tests pass
3. Present implementation to user
4. ⏸️ **STOP — Wait for explicit approval. Do NOT proceed.**

## gold — Implementation done, awaiting approval
1. Run the tests. If failing, fix implementation (not tests).
2. Present results to user
3. ⏸️ **STOP — Wait for explicit approval. Do NOT proceed.**
4. When approved: run `wdd complete <id>` and follow its output

## complete — Ward is done
- Tell user this ward is complete
- Suggest creating the next ward with /ward-new

## blocked — Ward is blocked
- Show what the ward depends on
- Suggest resolving the blocker

**NEVER skip a checkpoint. NEVER proceed without the user saying "approved" or "godkendt".**
