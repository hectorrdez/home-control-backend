import { Router } from "express";
import healthRoutes from "@modules/health/health.routes";
import haRoutes from "@modules/ha/ha.routes";
import entitiesRoutes from "@modules/entities/entities.routes";
import areasRoutes from "@modules/areas/areas.routes";
import streamRoutes from "@modules/stream/stream.routes";
// <modules:import>

/**
 * Aggregator only. Each domain module owns a Router under `src/modules/<name>/`;
 * this file mounts them and nothing else. `npm run new:module <name>` creates
 * a module and registers it at the markers.
 */
export const router: Router = Router();

router.use(healthRoutes);
router.use(haRoutes);
router.use(entitiesRoutes);
router.use(areasRoutes);
router.use(streamRoutes);
// <modules:use>
