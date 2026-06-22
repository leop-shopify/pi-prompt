---
description: "Production Data Cleanup Loop"
category: "Operations"
author: "Matthew Berman"
library_number: "014"
published: "2026-06-16"
modified: "2026-06-17"
---

# Production Data Cleanup Loop

## Prompt
Review production records, remove anything that does not meet the allowed definition, improve the classification logic, and verify the remaining data.

## When to use
Use this when a production dataset contains records that no longer match a product, policy, taxonomy, or quality definition and the classifier allowed them through.

## Success criteria
- Every remaining record meets the allowed definition.
- Representative classification tests and a post-cleanup audit prove the retained data is valid.

## Steps
1. Write the allowed definition as explicit inclusion, exclusion, and edge-case rules before changing data.
2. Audit production records, preserve a recoverable record of proposed removals, and separate clear violations from uncertain cases.
3. Remove confirmed invalid records through the approved production path and improve the classifier with regression examples.
4. Rerun classification tests and audit the remaining production data until every sampled and queried record meets the definition.

## Rationale
Fixing both the existing records and the classifier closes the immediate data problem and reduces recurrence. Explicit rules and regression examples make future cleanup decisions reviewable.

## Implementation notes
Follow access, retention, privacy, and audit requirements. Use backups or reversible operations where appropriate, and do not delete uncertain records without review.
