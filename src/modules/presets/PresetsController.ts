import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { recordEntityAction } from "@modules/events/ActionRecorder";
import { applyPreset, createPreset, deletePreset, listPresets, replacePreset, requirePreset } from "./PresetService";

export default class PresetsController extends Controller {
  static list = route("PresetsController:list", async (req: Request) =>
    listPresets(req.query.entityId === undefined ? undefined : String(req.query.entityId))
  );

  static create = route("PresetsController:create", async (req: Request, res: Response) =>
    createPreset(req.body, res.locals.clientId ?? null)
  );

  static replace = route("PresetsController:replace", async (req: Request, res: Response) =>
    replacePreset(String(req.params.id), req.body, res.locals.clientId ?? null)
  );

  static delete = route("PresetsController:delete", async (req: Request, res: Response) =>
    deletePreset(String(req.params.id), res.locals.clientId ?? null)
  );

  static apply = route("PresetsController:apply", async (req: Request, res: Response) => {
    const preset = requirePreset(String(req.params.id));
    return recordEntityAction(
      res,
      { entityId: preset.entityId, action: "preset", params: { presetId: preset.id, percent: preset.percent } },
      () => applyPreset(preset)
    );
  });
}
