# Interrupted task recovery

`src/server/quota-recovery.ts` owns quota and HTTP 429 continuations.

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
- Quota batches retain a 1.5 second pause after each send to observe immediate
  quota failures before sending the next task. Slow reads of the selected task
  can still delay that task; background history must not.

Run the focused checks after changing this flow:

```sh
npm run build:server
node --test tests/quota-recovery.test.cjs tests/rate-limit-recovery.test.cjs tests/quota-account-hook.test.cjs
```
