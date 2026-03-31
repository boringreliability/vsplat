---
epic: "native-web-foundation"
name: "The Native Web Foundation"
number: 1
status: "active"
created: "2026-03-31"
---
# Epic 01: The Native Web Foundation

## Goal
Få gigantiske filer fra brugerens desktop og ind i Rust-hukommelsen uden at browseren hoster. Etablér den fundamentale data-pipeline: feature detection → OPFS streaming → PLY parsing.

## Wards
| Ward | Name | Status |
|------|------|--------|
| 1 | Infrastructure & Feature Detection | planned |
| 2 | The OPFS Pipeline | planned |
| 3 | PLY Streaming Parser | planned |

## Integration Points
- Output fra Ward 3 (parsed SoA data) er direkte input til Epic 2 (ECS + WebGPU)
- OPFS pipeline genbruges i Epic 4 (Export Engine) til at skrive data tilbage

## Completion Criteria
- En .ply fil kan drag-droppes ind i browseren, streames til OPFS, og parses til Rust SoA arrays
- 5M splats loaded i < 3000ms
- Zero JS ArrayBuffer kopier af filindholdet
