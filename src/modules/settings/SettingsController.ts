import { Request, Response } from "express";
import Controller from "@templates/Controller";
import View from "@templates/View";
import { HANDLED, route } from "@shared/http/route";
import { deleteSetting, getSetting, listSettings, putSetting } from "./SettingsService";
import { VersionConflictError } from "./SettingErrors";

export default class SettingsController extends Controller {
  static list = route("SettingsController:list", async () => listSettings());

  static get = route("SettingsController:get", async (req: Request) => getSetting(String(req.params.key)));

  static put = route("SettingsController:put", async (req: Request, res: Response) => {
    try {
      return await putSetting(String(req.params.key), req.body, res.locals.clientId ?? null);
    } catch (err) {
      // 409 carries the current setting in `data` so the client can apply server-wins.
      if (err instanceof VersionConflictError) {
        const key = String(req.params.key);
        new View(res, err.current ? [{ key, ...err.current }] : [], 409, "version_conflict").send();
        return HANDLED;
      }
      throw err;
    }
  });

  static delete = route("SettingsController:delete", async (req: Request, res: Response) =>
    deleteSetting(String(req.params.key), res.locals.clientId ?? null)
  );
}
