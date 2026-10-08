import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

// The app server may project an abandoned inProgress turn as interrupted.
// Require the rollout to distinguish that from a recorded stop or completion.
export async function hasUnfinishedTurn(path: string, turnId: string) {
  const stream = createReadStream(path, {
    encoding: "utf8",
    signal: AbortSignal.timeout(5000),
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let current: string | undefined;
  let unfinished = false;
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      const item = row.payload;
      if (row.type === "event_msg" && item?.type === "task_started") {
        current = item.turn_id;
        unfinished = current === turnId;
      }
      if (current !== turnId) continue;
      if (
        (row.type === "event_msg" &&
          ["task_complete", "task_completed", "turn_aborted"].includes(
            item?.type,
          ) &&
          (!item.turn_id || item.turn_id === turnId)) ||
        (row.type === "response_item" &&
          item?.type === "message" &&
          (["final", "final_answer"].includes(item.phase) ||
            (item.role === "user" &&
              item.content?.some((part: { text?: string }) =>
                part.text?.includes("<turn_aborted>"),
              ))))
      )
        unfinished = false;
    }
    return current === turnId && unfinished;
  } catch {
    // Missing, truncated or unreadable evidence is not permission to replay.
    return false;
  } finally {
    lines.close();
    stream.destroy();
  }
}
