# Firebase Security Specification - HappyShare

## 1. Data Invariants
- An expense or payment cannot exist without a valid parent group.
- A user can only access groups where their `uid` is present in the `memberUids` array.
- A user can only access their own profile and friends list.
- All timestamps must be server-generated (`request.time` or `serverTimestamp()`) or strictly validated.
- Group IDs and sub-resource IDs must match the standard ID regex and size constraints.

## 2. The "Dirty Dozen" Payloads (Red Team Test Cases)

1. **Identity Spoofing**: Attempt to create a user profile with a different `uid` than the authenticated user.
   - *Expectation*: `PERMISSION_DENIED` (Rule `data.uid == request.auth.uid`).
2. **Resource Hijacking**: Attempt to read a group where the user is NOT a member.
   - *Expectation*: `PERMISSION_DENIED` (Rule `request.auth.uid in resource.data.memberUids`).
3. **Orphaned Writes**: Attempt to create an expense for a group ID that doesn't exist.
   - *Expectation*: `PERMISSION_DENIED` (Rule `isMemberOfGroup(groupId)` uses `get()` which fails if doc missing).
4. **Member Escalation**: Attempt to add oneself to a group by updating the `memberUids` array without being an existing member or invitee.
   - *Expectation*: `PERMISSION_DENIED` (Update requires `isMemberOfGroup`).
5. **PII Breach**: Attempt to read the friends list of another user.
   - *Expectation*: `PERMISSION_DENIED` (Rule `request.auth.uid == userId`).
6. **Denial of Wallet**: Attempt to use an extremely large string (1MB) as a document ID.
   - *Expectation*: `PERMISSION_DENIED` (Rule `isValidId` checks size <= 128).
7. **Timestamp Sabotage**: Attempt to set a past or future `ts` for an expense to manipulate reporting.
   - *Expectation*: Should Ideally be validated against `request.time`. (Current rules use `data.ts is number`).
8. **Shadow Field Injection**: Attempt to create a group with an extra `isVerifiedAdmin: true` field.
   - *Expectation*: `PERMISSION_DENIED` (Rule `isValidGroup` uses `keys().hasAll()` and `keys().size() == 8`).
9. **Negative Funds**: Attempt to create an expense with `amount: -1000`.
   - *Expectation*: `PERMISSION_DENIED` (Rule `data.amount > 0`).
10. **State Corruption**: Attempt to change the `leader` of a group without being the current leader.
    - *Expectation*: `PERMISSION_DENIED` (Update rule `existing().leader == request.auth.uid`).
11. **Cross-User Deletion**: Attempt to delete another user's expense.
    - *Expectation*: `PERMISSION_DENIED` (Rule `existing().createdBy == request.auth.uid`).
12. **Verification Bypass**: Attempt to write data with an unverified email account.
    - *Expectation*: `PERMISSION_DENIED` (Rule `isVerified()` check).

## 3. Test Runner - firestore.rules.test.ts
(This file would contain the actual tests using `@firebase/rules-unit-testing`)
