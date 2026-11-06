import { Request } from "express";
import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import { listAliases, setAlias, deleteAlias } from "./AliasesService";

export default class AliasesController extends Controller {
  static list = route("AliasesController:list", async () => listAliases());

  static put = route("AliasesController:put", async (req: Request) =>
    setAlias(String(req.params.entityId), (req.body as { alias?: unknown } | undefined)?.alias)
  );

  static delete = route("AliasesController:delete", async (req: Request) =>
    deleteAlias(String(req.params.entityId))
  );
}
