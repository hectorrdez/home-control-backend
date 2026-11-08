import express from "express";
import cors, { CorsOptions } from "cors";
import { router } from "./routes";
import { apiKeyGate } from "@shared/guards/apiKey";
import { clientIdentity } from "@shared/http/clientIdentity";
import errorHandler from "@shared/middlewares/ErrorMiddleware";
import RouteNotFoundError from "@errors/RouteNotFoundError";
import DateUtils from "@utils/Date";

const app = express();
app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.locals.entry = DateUtils.obtainCurrentDateString();
  next();
});

// CORS. `CORS_ORIGINS` = comma-separated allowlist. Unset (local dev) reflects
// any request Origin. `credentials: true` is needed for cookie sessions and
// forbids a `*` origin, hence the reflect.
const allowlist = (process.env.CORS_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const corsOptions: CorsOptions = {
  origin: allowlist.length ? allowlist : true,
  credentials: true,
};
app.use(cors(corsOptions));

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use("/api", apiKeyGate);
app.use("/api", clientIdentity);
// <app:middlewares> (create-project inserts optional middleware above this line)
app.use("/api", router);
app.use((_req, _res, next) => next(new RouteNotFoundError()));
app.use(errorHandler);

export default app;
