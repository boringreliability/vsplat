---
name: ward-new
description: "Create a new WDD Ward with full spec, tests table, must-not/must-do lists, and test file. Use when starting new work."
---

# /ward-new — Create a New Ward

1. Ask the user for:
   - Ward name (what it builds)
   - Epic (suggest existing epics from `.wdd/epics/`)
   - Estimated test count
2. Run `wdd ward create "Name" --epic <slug> --tests <N>`
3. Open the created ward file and write the full spec:
   - Scope (one paragraph)
   - Inputs (what it uses from previous wards)
   - Outputs (what it produces)
   - Specification (detailed technical spec)
   - Tests table (# | test_name | what it verifies)
   - Must NOT list (explicit constraints)
   - Must DO list (explicit requirements)
   - Verification (how to prove it's done)
4. Run `wdd ward status <id> red`
5. Write the test file based on the Tests table
6. Present tests to user
7. ⏸️ **STOP — Wait for explicit approval before implementing**
