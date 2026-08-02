// Minimal product analytics: the landing -> board -> compare -> share funnel.
//
// This endpoint is reachable by anyone holding the public anon key, so the
// event name is whitelisted and props are clamped rather than trusted. Writing
// junk into mp_events is still possible, but it can't grow unbounded rows or
// invent event names that would quietly pollute the funnel view.

import { db, ok, err } from "./shared.ts";

const EVENTS = new Set([
  "landing",         // app opened; props.from = share | direct | party
  "board_complete",  // a tier board was saved
  "compare_view",    // the "You vs. the room" reveal was reached
  "share_click",     // share was tapped; props.scored = true | false
  "theme_open",      // a curated theme was opened; props.theme = slug
]);

// Only these prop keys are kept, and only as short scalars.
const PROP_KEYS = new Set(["from", "scored", "daily", "authors", "theme", "unlocked", "spice"]);

function clampProps(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!PROP_KEYS.has(k)) continue;
    if (typeof v === "boolean" || typeof v === "number") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, 32);
  }
  return out;
}

export async function actionTrack(_req: Request, body: any) {
  const event = String(body.event ?? "");
  if (!EVENTS.has(event)) return err("unknown_event", 400);

  const clientId = body.client_id ? String(body.client_id).slice(0, 64) : null;

  // Fire-and-forget on the client's side; a failed insert must never surface
  // as a broken interaction, so swallow the error and always return ok.
  await db.from("mp_events").insert({
    event,
    client_id: clientId,
    props: clampProps(body.props),
  });

  return ok();
}
