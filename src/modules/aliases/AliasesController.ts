import { Request, Response } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listAliases, setAlias, deleteAlias } from "./AliasesService";

export default class AliasesController extends Controller {
  static list = route("AliasesController:list", async () => listAliases());

  static put = route("AliasesController:put", async (req: Request, res: Response) =>
    setAlias(String(req.params.entityId), (req.body as { alias?: unknown } | undefined)?.alias, res.locals.clientId ?? null)
  );

  static delete = route("AliasesController:delete", async (req: Request, res: Response) =>
    deleteAlias(String(req.params.entityId), res.locals.clientId ?? null)
  );
}
