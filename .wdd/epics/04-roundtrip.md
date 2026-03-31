---
epic: "roundtrip"
name: "The Roundtrip"
number: 4
status: "active"
created: "2026-03-31"
---
# Epic 04: The Roundtrip

## Goal
Få det rensede data ud af systemet igen. Complete the loop: import → edit → export.

## Wards
| Ward | Name | Status |
|------|------|--------|
| 11 | Export Engine | planned |

## Integration Points
- Genbruger OPFS pipeline fra Epic 1
- Læser ECS data fra Epic 2 (med Deleted-filtrering fra Epic 3)

## Completion Criteria
- Eksport af rensede .ply filer i industristandard format
- Deleted splats er filtreret fra
- Round-trip test: import → delete → export → re-import er korrekt
- Eksport af 5M splats < 2000ms
