import { RegExpRouter } from "hono/router/reg-exp-router";
import { SmartRouter } from "hono/router/smart-router";
import { TrieRouter } from "hono/router/trie-router";
import type { Hono } from "hono";
import type { Router } from "hono/router";
import { CORE_JOBS, CORE_ROUTES, NON_CORE_FEATURES } from "./core-allowlist.ts";

// The launch surface (security review round 4, Part A): what a router process serves and runs AT ALL.
//
// Four review rounds kept finding new problems in features the launch does not use. LAUNCH_TIER and the per-feature
// flags are opt-out: a route or a job exists unless something switches it off. The launch surface is the opposite. With
// LAUNCH_SURFACE=core (the default everywhere) a route is registered only when its exact `METHOD path`, under the route
// group that registers it, is on the checked-in allow-list (core-allowlist.ts), and a background job runs only when its
// name is on the job allow-list. Everything else is never added to the HTTP router and never handed to the job
// scheduler, whatever its own feature flag says. A new route or job is therefore off until someone adds it to the list.
//
// One choke point each:
//   routes  Hono adds every handler (get/post/on/all/use/route) through `router.add`. createApp gives Hono the router
//           built here, whose `add` consults the allow-list. A refused registration is recorded (for /api/v1/status) and
//           dropped: no handler for it exists in the process's router.
//   jobs    services/jobs.ts `Jobs.register` asks `jobAllowed` before it stores a job.
//
// LAUNCH_SURFACE=all restores the full surface. In production it needs LAUNCH_SURFACE_ACK=<SURFACE_ACK> (config.ts).

export const LAUNCH_SURFACES = ["core", "all"] as const;
export type LaunchSurface = (typeof LAUNCH_SURFACES)[number];
export const SURFACE_ACK = "i-have-reviewed-the-extra-features";
export const NOT_ENABLED = "not_enabled";

/** Paths the API owns: an unmatched request under one of these is answered as JSON, never with the site's 404 page. */
export const API_NAMESPACE = /^\/(?:api|v1|trpc|mcp|ollama|facilitator|\.well-known)(?:\/|$)/;

export const routeKey = (method: string, path: string) => `${method.toUpperCase()} ${path}`;

type Registration = { group: string; method: string; path: string };

export class Surface {
  /** Registrations the allow-list admitted, in order. In core: at most one per (group, method, path), see `router`. */
  readonly registered: Registration[] = [];
  /** Registrations it refused (core only): group, method and path. */
  readonly fenced: Registration[] = [];
  /** Route groups that were not called at all (core only). */
  readonly skippedGroups: string[] = [];
  readonly mountedGroups: string[] = [];
  readonly fencedJobs: string[] = [];
  private current: string | null = null;

  constructor(readonly surface: LaunchSurface) {}

  get core() {
    return this.surface === "core";
  }

  /** The router createApp hands to Hono: the default router pair behind the allow-list. */
  router<T>(): Router<T> {
    const inner = new SmartRouter<T>({ routers: [new RegExpRouter(), new TrieRouter()] });
    return {
      name: "SurfaceRouter",
      add: (method, path, handler) => {
        // In core nothing reaches the router outside a named group: a registration with no group is refused outright.
        // The full surface gates nothing, so a route added there outside a group (a test harness does) is recorded as such.
        const group = this.current ?? (this.core ? null : "unscoped");
        if (!group) throw new Error(`Route ${routeKey(method, path)} was registered outside a launch-surface group (src/app.ts mount()); LAUNCH_SURFACE=core registers nothing that is not on its allow-list.`);
        const reg = { group, method: method.toUpperCase(), path };
        if (this.core && !CORE_ROUTES[group]?.includes(routeKey(method, path))) {
          this.fenced.push(reg);
          return;
        }
        // R5-12: an allow-list entry admits ONE handler. The route table is a set of keys, so a second handler under a
        // listed key (a middleware added with app.use, a second handler on a chat path) used to be admitted without any
        // snapshot changing. In core it stops the start instead: nothing unlisted is served, and nothing is dropped quietly.
        if (this.core && this.registered.some((r) => r.group === group && r.method === reg.method && r.path === path))
          throw new Error(`A second handler was registered for ${routeKey(method, path)} in launch-surface group ${group}. LAUNCH_SURFACE=core admits one handler per allow-listed route (src/surface/core-allowlist.ts): register it under a route of its own and list that route, or leave it out of core.`);
        this.registered.push(reg);
        inner.add(method, path, handler);
      },
      match: (method, path) => inner.match(method, path),
    };
  }

  /**
   * Run one route group's registration. In `core` a group that is not on the allow-list is not called at all, so nothing
   * it would set up exists (routes, middleware, timers); a listed group is called and each route it registers is still
   * checked on its own.
   */
  mount(group: string, register: () => void): void {
    if (this.current) throw new Error(`Launch-surface group ${group} was mounted inside ${this.current}.`);
    if (this.core && !Object.hasOwn(CORE_ROUTES, group)) {
      this.skippedGroups.push(group);
      return;
    }
    this.current = group;
    try {
      register();
      this.mountedGroups.push(group);
    } finally {
      this.current = null;
    }
  }

  /** Drop refused registrations from Hono's own listing, so `app.routes` says what is served. */
  prune(app: Hono): void {
    if (!this.core) return;
    const left = new Map<string, number>();
    for (const r of this.registered) left.set(routeKey(r.method, r.path), (left.get(routeKey(r.method, r.path)) ?? 0) + 1);
    app.routes = app.routes.filter((r) => {
      const k = routeKey(r.method, r.path);
      const n = left.get(k) ?? 0;
      if (n <= 0) return false;
      left.set(k, n - 1);
      return true;
    });
  }

  jobAllowed(name: string): boolean {
    if (!this.core || CORE_JOBS.includes(name)) return true;
    if (!this.fencedJobs.includes(name)) this.fencedJobs.push(name);
    return false;
  }

  /** The distinct `METHOD path` keys that are served, sorted: what the route-table test compares with the checked-in file. */
  routeTable(): string[] {
    return [...new Set(this.registered.map((r) => `${r.group}\t${routeKey(r.method, r.path)}`))].sort();
  }

  /** What GET /api/v1/status says under `launch_surface`. */
  status(jobs: string[]) {
    return {
      surface: this.surface,
      // The route groups that are mounted, and the background jobs this process registered.
      core: this.mountedGroups,
      jobs,
      // What is off because of the surface: named features, the route groups that were not mounted, and how many routes
      // and jobs were refused inside mounted groups. A request to any of them is answered 404 `not_enabled`.
      off: this.core ? Object.keys(NON_CORE_FEATURES) : [],
      off_groups: this.skippedGroups,
      off_routes: new Set(this.fenced.map((r) => routeKey(r.method, r.path))).size,
      off_jobs: this.fencedJobs,
      not_enabled: { status: 404, type: NOT_ENABLED },
      note: this.core
        ? "LAUNCH_SURFACE=core: only the allow-listed routes and jobs exist on this router. Every other feature is not registered, whatever its own setting says."
        : "LAUNCH_SURFACE=all: every feature whose own setting is on is registered.",
    };
  }
}
