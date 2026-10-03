# Interrupted task recovery

`src/server/quota-recovery.ts` owns quota and HTTP 429 continuations.

- Continuation messages ask for direct resumption without a recovery-specific
  inventory or recap. Child failures are resolved to the parent task; the message
  asks that parent to continue existing child agents in their original context
  instead of replacing them solely because of the interruption.
- Same-account login checks retain the quota snapshot from principal cache
  invalidation until `account/updated`, so an earlier fresh quota read cannot
  erase the exhausted-to-available transition. Quota reads alone do not resume work.
- A live terminal quota error also supplies the pre-login exhaustion evidence
  for the observed account. Failed quota reads cannot erase it; a real identity
  change or verified recovery consumes it. Persisted failures from before the
  account baseline are not treated as evidence about the current account.
  Same-account recovery still requires an explicit account update and a fresh,
  matching quota response that permits ordinary usage. Account-update logs
  record the decision without account identifiers or credentials.
- History discovery is background work. Known continuations wait for the send
  lock, never for a history page or unrelated unresolved records. Manual resume
  resolves only the selected records and their parent chains.
- History readers validate entry identity, status, and thread revisions after
  asynchronous reads. A late result must not overwrite a newer notification or
  continuation. Discovery yields while a continuation is being prepared.
- Enabling 429 recovery or reconnecting a host immediately schedules known
  deadlines; history discovery can add more candidates afterward.
- Sends remain serialized. Archive, current turn, account/preference, and parent
  checks still run before dispatch. The client message ID and consumed retry
  budget are persisted before transport writes. Unknown delivery is never
  automatically replayed.
- Refresh retires an uncertain recovery record when the interrupted turn is
  followed by confirmed user input. This does not confirm delivery of the old
  message: its client ID and uncertainty remain in the ledger. History scan
  invalidation is not a read failure; a fresh full scan replaces old warnings.
- Quota batches retain a 1.5 second pause after each send to observe immediate
  quota failures before sending the next task. Slow reads of the selected task
  can still delay that task; background history must not.

Run the focused checks after changing this flow:

```sh
npm run build:server
node --test tests/quota-recovery.test.cjs tests/rate-limit-recovery.test.cjs tests/quota-account-hook.test.cjs
```
