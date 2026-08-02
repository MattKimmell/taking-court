// -----------------------------------------------------------------------------
// URL -> QR code SVG, rendered server-side.
//
// Why server-side: the front-end is a single hand-written file with no build
// step, and a CDN <script> would put a network fetch in the critical path of
// joining a party — exactly where flaky venue wifi lives. service-worker.js's
// SHELL doesn't cache cross-origin scripts, so a cold load on bad wifi could
// break the wedge feature. Rendering here costs zero client bytes and the
// endpoint is reusable for tier/list share links.
//
// Why a library and not a hand-rolled encoder: the first version of this file
// was hand-written and produced codes that no decoder could read — verified by
// rendering the matrix and running jsQR over it. QR's version/EC block tables,
// format bits, and mask selection are easy to get subtly and silently wrong,
// and the failure mode is "nobody can join, discovered at the bar". `npm:` here
// is a deploy-time dependency resolved by the Supabase CLI, not a runtime fetch,
// so it carries none of the risk that ruled out the client-side CDN.
// -----------------------------------------------------------------------------
import QRCode from "npm:qrcode@1.5.4";
import { ok, err } from "./shared.ts";

const MAX_URL = 300;

export async function actionQr(_req: Request, body: any) {
  const url = String(body.url ?? "");
  if (!url) return err("missing_url", 400);
  if (url.length > MAX_URL) return err("url_too_long", 400);
  try {
    const svg: string = await QRCode.toString(url, {
      type: "svg",
      errorCorrectionLevel: "M",   // join URLs are short and scanned from a foot away
      margin: 4,
    });
    return ok({ svg });
  } catch (e) {
    return err(`qr_failed: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
}
