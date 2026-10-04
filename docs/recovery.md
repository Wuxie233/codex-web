# Interrupted task recovery

`src/server/quota-recovery.ts` owns quota, expired-credential, and HTTP 429 continuations.

- Terminal access-token refresh failures (`Your access token could not be
  refreshed`, `refresh_token_expired`, `refresh_token_reused`, or
  `refresh_token_invalidated`) use the quota/account-change recovery path in
  both notifications and history scans. They wait for refreshed credentials
  and usable quota; generic network errors and HTTP 401 alone do not qualify.
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
  Same-account recovery requires an explicit account update or an established
  backend connection reconnecting after a disconnect, followed by a fresh,
  matching quota response that permits ordinary usage. Account-update logs
  record the decision without account identifiers or credentials. The initial
  connection only establishes a baseline. Reconnection covers external credential
  switchers that restart the backend without emitting `account/updated`.
- Account checks run in the server connection, without browser clients. An
  inconclusive quota read after an eligible account event retains that event
  and retries after 5, 10, 20, then 30 seconds between completed reads. A new
  account event, disconnect, logout, identity change, or disposal cancels the
  old retry. Each result still checks the original account and quota revision;
  ordinary periodic reads cannot create a recovery event.
- Server logs under `[quota-recovery]` distinguish account-check source, quota
  read failure and retry delay, queue waiting, and manual/account-switch/429
  dispatch and confirmation. Logs contain timings and thread IDs, not credentials
  or message contents. A dispatch without confirmation remains unknown.
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
