// Router entry for the `mp` edge function. All logic lives in sibling modules
// (shared / games / lists / tiers / crews); this file only maps actions to them.
import { CORS, err } from "./shared.ts";
import { actionSheets, actionCreate, actionOpen, actionStart, actionGuess, actionResults, actionAddBot, actionLeaderboard, actionSuggest, actionChallengeCatalog, actionChallengeFilters, actionChallengePreview, actionChallengeBuild } from "./games.ts";
import { actionListCreate, actionListSave, actionListOpen, actionListCompare, actionListMine, actionListBrowse, actionListSubmit } from "./lists.ts";
import { actionTierCreate, actionTierReroll, actionTierOpen, actionTierSave, actionTierCompare, actionTierMine, actionTierBrowse, actionTierSubmit, actionTierThemes, actionDaily } from "./tiers.ts";
import { actionCrewCreate, actionCrewJoin, actionCrewMine, actionCrewDaily, actionCrewReact } from "./crews.ts";
import { actionTrack } from "./events.ts";
import { actionPartyPrompts, actionPartyCreate, actionPartyJoin, actionPartyStart, actionPartyGuess, actionPartyState, actionPartyEnd, actionPartyRoundNext, actionPartyTierSave, actionPartyTurn } from "./party.ts";
import { actionQr } from "./qr.ts";

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return err("method_not_allowed", 405);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return err("invalid_json", 400);
  }

  try {
    switch (body.action) {
      case "sheets":
        return await actionSheets();
      case "create":
        return await actionCreate(req, body);
      case "open":
        return await actionOpen(req, body);
      case "start":
        return await actionStart(req, body);
      case "guess":
        return await actionGuess(req, body);
      case "results":
        return await actionResults(req, body);
      case "add_bot":
        return await actionAddBot(req, body);
      case "leaderboard":
        return await actionLeaderboard(req, body);
      case "challenge_catalog":
        return await actionChallengeCatalog();
      case "challenge_filters":
        return await actionChallengeFilters();
      case "challenge_preview":
        return await actionChallengePreview(req, body);
      case "challenge_build":
        return await actionChallengeBuild(req, body);
      case "suggest":
        return await actionSuggest(req, body);
      case "list_create":
        return await actionListCreate(req, body);
      case "list_save":
        return await actionListSave(req, body);
      case "list_open":
        return await actionListOpen(req, body);
      case "list_compare":
        return await actionListCompare(req, body);
      case "list_mine":
        return await actionListMine(req, body);
      case "list_browse":
        return await actionListBrowse(req, body);
      case "list_submit":
        return await actionListSubmit(req, body);
      case "tier_create":
        return await actionTierCreate(req, body);
      case "tier_reroll":
        return await actionTierReroll(req, body);
      case "tier_open":
        return await actionTierOpen(req, body);
      case "tier_save":
        return await actionTierSave(req, body);
      case "tier_compare":
        return await actionTierCompare(req, body);
      case "tier_mine":
        return await actionTierMine(req, body);
      case "tier_browse":
        return await actionTierBrowse(req, body);
      case "tier_submit":
        return await actionTierSubmit(req, body);
      case "tier_themes":
        return await actionTierThemes();
      case "daily":
        return await actionDaily(req, body);
      case "crew_create":
        return await actionCrewCreate(req, body);
      case "crew_join":
        return await actionCrewJoin(req, body);
      case "crew_mine":
        return await actionCrewMine(req, body);
      case "crew_daily":
        return await actionCrewDaily(req, body);
      case "crew_react":
        return await actionCrewReact(req, body);
      case "track":
        return await actionTrack(req, body);
      case "party_prompts":
        return await actionPartyPrompts();
      case "party_create":
        return await actionPartyCreate(req, body);
      case "party_join":
        return await actionPartyJoin(req, body);
      case "party_start":
        return await actionPartyStart(req, body);
      case "party_guess":
        return await actionPartyGuess(req, body);
      case "party_state":
        return await actionPartyState(req, body);
      case "party_end":
        return await actionPartyEnd(req, body);
      case "party_round_next":
        return await actionPartyRoundNext(req, body);
      case "party_tier_save":
        return await actionPartyTierSave(req, body);
      case "party_turn":
        return await actionPartyTurn(req, body);
      case "qr":
        return await actionQr(req, body);
      default:
        return err("unknown_action", 400);
    }
  } catch (e) {
    return err(`server_error: ${e instanceof Error ? e.message : String(e)}`, 500);
  }
});
