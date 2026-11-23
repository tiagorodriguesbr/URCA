# Security Specification — Creps Urca Transition Platform

## 1. Data Invariants
1. **Strict RBAC Boundary**: Only verified Full Admins (`tiago.rodrigues2933@gmail.com` with `email_verified == true`, or active users in `/users/{uid}` with `role in ['socio', 'diretor', 'master']`) have unrestricted administrative privileges (`users`, `partners`, `tasks`, `payments`, `inventory_periods`, `inventory_items`, `audit_logs` read/export, and inventory approval/rejection/deletion). Store Managers (`role in ['gerente', 'manager']` with `active == true`) can read workspace collections (`partners`, `tasks`, `payments`, `inventory_periods`, `inventory_items`) and can only mutate collections explicitly authorized in their `editableTabs` (`checklist`, `payments`, `inventory`).
2. **PII Isolation**: `/users/{userId}` contains personal emails. `get` is restricted to the profile owner or a Full Admin (`socio`/`diretor`/`master`). `list` is restricted exclusively to Full Admins. Non-PII partner display names live in `/partners/{partnerId}`.
3. **Immutable Audit Trail**: `/audit_logs/{logId}` is append-only (`create` allowed for Full Admins or active Managers with at least one `editableTabs` permission, enforcing `actorUid == request.auth.uid` and `timestamp == request.time`; `read` restricted to Full Admins; `update` and `delete` unconditionally denied).
4. **Inventory Locking & Approval Flow**: `/inventory_periods/{periodId}` enforces `periodId == 'creps-urca_' + monthKey`, starts in `'rascunho'`, can only be moved to `'aprovado'` or `'recusado'` by Full Admins while `'aguardando_validacao'`, and blocks all item/period mutations once `'aprovado'`.
5. **Temporal, Key & Volumetric Guards**: Every `create` requires `createdAt == request.time`, `updatedAt == request.time`, and `createdByUid == request.auth.uid`. Every `update` preserves immutable identity/creation fields and enforces `updatedAt == request.time`. All document IDs match `^[a-zA-Z0-9_\-]+$` (`<= 128` chars), strings enforce bounds matching `firebase-blueprint.json`, and `keys().hasOnly(...)` rejects shadow fields.
6. **Payment Receipt Images**: `/payment_receipts/{paymentId}` enforces `existsAfter(/payments/{paymentId})`, restricts MIME/prefix to `image/jpeg` or `image/png` data URLs bounded to `<= 450,000` bytes, and follows the `payments` edit permission (`isFullAdmin()` or `isGerenteWithEdit('payments')`).

## 2. "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated Read/Write**: Read `/tasks/t1` with `auth == null` -> `PERMISSION_DENIED`.
2. **Manager Privilege Escalation (Self-Promotion)**: User with `role: 'gerente'` updates `/users/{ownUid}` setting `role: 'diretor'` or adding `editableTabs` -> `PERMISSION_DENIED`.
3. **Read-Only Manager Task Mutation**: User with `role: 'gerente'` and `editableTabs: ['inventory']` attempts `create`, `update`, or `delete` on `/tasks/{taskId}` -> `PERMISSION_DENIED`.
4. **Read-Only Manager Payment Mutation**: User with `role: 'gerente'` and `editableTabs: ['checklist']` attempts `create`, `update`, or `delete` on `/payments/{paymentId}` -> `PERMISSION_DENIED`.
5. **Spoofed Admin Email (Unverified)**: Attacker authenticates with `email: 'tiago.rodrigues2933@gmail.com'` and `email_verified: false` -> `PERMISSION_DENIED`.
6. **Shadow Field Injection**: Full Admin sends `tasks` or `inventory_periods` payload with an extra `{ isVerified: true }` field -> `PERMISSION_DENIED`.
7. **Audit Log Tampering**: Full Admin attempts `update` or `delete` on `/audit_logs/{logId}` -> `PERMISSION_DENIED`.
8. **Actor Spoofing in Audit Log**: User attempts to create `/audit_logs/{logId}` with `actorUid` set to another user's UID -> `PERMISSION_DENIED`.
9. **Client Timestamp Forgery**: Full Admin attempts `create` on `/payments/{paymentId}` with backdated `createdAt` (`createdAt != request.time`) -> `PERMISSION_DENIED`.
10. **Approved Inventory Mutation**: Manager or Full Admin attempts to update or delete `/inventory_periods/{periodId}` or `/inventory_items/{itemId}` when period `status == 'aprovado'` -> `PERMISSION_DENIED`.
11. **Manager Inventory Self-Approval**: Manager attempts to update `/inventory_periods/{periodId}` setting `status: 'aprovado'` -> `PERMISSION_DENIED`.
12. **PII Enumeration by Manager**: Manager attempts `list` on `/users` or `get` on another user's `/users/{otherUid}` -> `PERMISSION_DENIED`.
