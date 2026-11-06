// Usage: npm run new:module <name>   e.g. npm run new:module invoices
const fs = require("node:fs");
const path = require("node:path");

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9]*$/.test(name)) {
  console.error("Use: npm run new:module <name>  (lowercase letters/digits, starts with a letter)");
  process.exit(1);
}
const Pascal = name[0].toUpperCase() + name.slice(1);
const dir = path.join(__dirname, "..", "src", "modules", name);
if (fs.existsSync(dir)) {
  console.error(`Module already exists: src/modules/${name}`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });

fs.writeFileSync(path.join(dir, `${name}.routes.ts`), `import { Router } from "express";
import ${Pascal}Controller from "./${Pascal}Controller";

const routes: Router = Router();

routes.get("/${name}", ${Pascal}Controller.list);

export default routes;
`);

fs.writeFileSync(path.join(dir, `${Pascal}Controller.ts`), `import Controller from "@templates/Controller";
import { route } from "@shared/http/route";
import ${Pascal}Model from "./${Pascal}Model";

const model = new ${Pascal}Model();

export default class ${Pascal}Controller extends Controller {
  static list = route("${Pascal}Controller:list", async () => model.list());
}
`);

fs.writeFileSync(path.join(dir, `${Pascal}Model.ts`), `import Repository from "@shared/db/Repository";

export default class ${Pascal}Model extends Repository {
  async list(): Promise<unknown[]> {
    return [];
  }
}
`);

const routesFile = path.join(__dirname, "..", "src", "routes.ts");
let src = fs.readFileSync(routesFile, "utf8");
src = src.replace("// <modules:import>", `import ${name}Routes from "@modules/${name}/${name}.routes";\n// <modules:import>`);
src = src.replace("// <modules:use>", `router.use(${name}Routes);\n// <modules:use>`);
fs.writeFileSync(routesFile, src);
console.log(`Created src/modules/${name} and registered it in src/routes.ts`);
