/**
 * Per-agent place pinning (dallen fork).
 *
 * Every agent session runs its own stdio process. All of them share one primary
 * HTTP bridge and one auth token, so without a pin any agent can address any
 * open place by its instance_id. A pin limits this stdio process to the places
 * its agent owns.
 *
 * Keys (comma-separated in ROBLOX_STUDIO_PLACE, or the `pin_place` tool):
 * - a place file name ("MyGame.rbxl", matched exactly);
 * - a prefix ending in "*" ("MyGame*" matches MyGame.rbxl and MyGame-QA.rbxl);
 * - a numeric place id (places opened from Roblox report their id).
 *
 * ROBLOX_STUDIO_REQUIRE_PIN=1 makes an unpinned process refuse every Studio
 * tool until it is pinned. These semantics match roblox-studio-mcp 0.3.x
 * (placePin.ts) so agents and scripts keep the same keys.
 *
 * Enforcement is at the stdio invoke choke point (server.ts): routed tools must
 * name a pinned instance (one is injected when the pin matches exactly one open
 * place); ids of other places are refused with `pin_violation`;
 * get_connected_instances is filtered. This is advisory isolation between
 * cooperating agents (they share the token), not a security boundary.
 */
import type { BridgeService } from './bridge-service.js';
import type { ToolDefinition } from './tools/definitions.js';

export type PinState =
  | { kind: 'open' }
  | { kind: 'locked' }
  | { kind: 'pinned'; keys: readonly string[] };

export class PinViolationError extends Error {
  readonly code = 'pin_violation';
  readonly pin: readonly string[];

  constructor(message: string, pin: readonly string[]) {
    super(message);
    this.name = 'PinViolationError';
    this.pin = pin;
  }
}

export function parsePinKeys(raw: unknown): string[] {
  const values = Array.isArray(raw) ? raw : [raw];
  return values
    .flatMap((value) => (typeof value === 'string' || typeof value === 'number' ? String(value).split(',') : []))
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

export function keyMatchesPlace(key: string, placeName: unknown, placeId: unknown): boolean {
  const name = typeof placeName === 'string' ? placeName : '';
  const id = typeof placeId === 'number' || typeof placeId === 'string' ? String(placeId) : '';
  if (key.endsWith('*')) return key.length > 1 && name.startsWith(key.slice(0, -1));
  return key === name || (id !== '' && id !== '0' && key === id);
}

function envFlag(value: string | undefined): boolean {
  return ['1', 'true', 'yes'].includes((value ?? '').trim().toLowerCase());
}

interface PinnableInstance {
  id: string;
  multiplayerGroupId?: string;
  placeId: number;
  placeName: string;
}

interface PinnableGroup {
  id: string;
  controllerInstanceId?: string;
  instanceIds?: string[];
  instances?: Record<string, string>;
}

/** Arguments that name a Studio routing scope. */
const SCOPE_ARGS = ['instance_id', 'multiplayer_group_id'] as const;
/** manage_instance actions that never touch a specific place. */
const MANAGE_READ_ONLY_ACTIONS = new Set(['status', 'list_place_versions']);

export class PlacePinGuard {
  private state: PinState;
  private readonly routedTools: Set<string>;

  constructor(
    definitions: readonly ToolDefinition[],
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const keys = parsePinKeys(env.ROBLOX_STUDIO_PLACE ?? '');
    this.state = keys.length > 0
      ? { kind: 'pinned', keys }
      : envFlag(env.ROBLOX_STUDIO_REQUIRE_PIN) ? { kind: 'locked' } : { kind: 'open' };
    this.routedTools = new Set(
      definitions
        .filter((definition) => {
          const properties = (definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
          return SCOPE_ARGS.some((arg) => arg in properties);
        })
        .map((definition) => definition.name),
    );
  }

  get pinState(): PinState {
    return this.state;
  }

  get keys(): readonly string[] {
    return this.state.kind === 'pinned' ? this.state.keys : [];
  }

  setPin(raw: unknown): PinState {
    const keys = parsePinKeys(raw);
    if (keys.length === 0) throw new Error('pin_place needs at least one place key');
    this.state = { kind: 'pinned', keys };
    return this.state;
  }

  describe(): Record<string, unknown> {
    return this.state.kind === 'pinned'
      ? { pinned: true, keys: [...this.state.keys] }
      : { pinned: false, required: this.state.kind === 'locked' };
  }

  acceptsPlace(placeName: unknown, placeId: unknown): boolean {
    switch (this.state.kind) {
      case 'open': return true;
      case 'locked': return false;
      case 'pinned': return this.state.keys.some((key) => keyMatchesPlace(key, placeName, placeId));
    }
  }

  /** Top-level instances whose place matches the pin. */
  pinnedInstances(bridge: BridgeService): PinnableInstance[] {
    return bridge.getConnectedInstances().filter((instance) => this.acceptsPlace(instance.placeName, instance.placeId));
  }

  /** Multiplayer groups started from a pinned instance. */
  pinnedGroups(bridge: BridgeService, pinnedIds: ReadonlySet<string>): PinnableGroup[] {
    return bridge.getMultiplayerGroups().filter((group) =>
      group.controllerInstanceId !== undefined && pinnedIds.has(group.controllerInstanceId));
  }

  /** Every instance id this process may address: pinned places plus their playtest peers. */
  allowedScope(bridge: BridgeService): { instanceIds: Set<string>; groupIds: Set<string>; pinned: PinnableInstance[] } {
    const pinned = this.pinnedInstances(bridge);
    const pinnedIds = new Set(pinned.map((instance) => instance.id));
    const groups = this.pinnedGroups(bridge, pinnedIds);
    const groupIds = new Set(groups.map((group) => group.id));
    const instanceIds = new Set(pinnedIds);
    for (const group of groups) for (const id of group.instanceIds ?? []) instanceIds.add(id);
    for (const instance of bridge.getConnectedInstances()) {
      if (instance.multiplayerGroupId !== undefined && groupIds.has(instance.multiplayerGroupId)) {
        instanceIds.add(instance.id);
      }
    }
    return { instanceIds, groupIds, pinned };
  }

  private violation(message: string): PinViolationError {
    const hint = this.state.kind === 'pinned'
      ? `This agent is pinned to ${this.state.keys.join(', ')}.`
      : 'This agent is not pinned (ROBLOX_STUDIO_REQUIRE_PIN=1); call pin_place with your project keys first.';
    return new PinViolationError(`${message} ${hint}`, this.keys);
  }

  /**
   * Checks one tool call and returns the arguments to run it with (an
   * instance_id is injected when exactly one pinned place is open). Throws
   * PinViolationError when the call would reach an unpinned place.
   */
  async check(bridge: BridgeService, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.state.kind === 'open') return args;
    if (name === 'pin_place' || name === 'get_connected_instances') return args;
    const routed = this.routedTools.has(name);
    if (!routed && name !== 'manage_instance') return args;

    if (this.state.kind === 'locked') {
      if (name === 'manage_instance' && MANAGE_READ_ONLY_ACTIONS.has(String(args.action))) return args;
      throw this.violation(`${name} refused: no place is pinned.`);
    }

    const refresh = bridge.refreshTopologyForRouting();
    if (refresh) await refresh;
    const scope = this.allowedScope(bridge);

    if (name === 'manage_instance') return this.checkManageInstance(bridge, args, scope.instanceIds);

    const instanceId = args.instance_id;
    if (instanceId !== undefined) {
      const id = String(instanceId);
      const resolved = bridge.resolveConnectedInstanceId(id) ?? id;
      if (!scope.instanceIds.has(resolved) && !scope.instanceIds.has(id)) {
        throw this.violation(`instance_id ${id} is not a pinned place.`);
      }
    }
    const groupId = args.multiplayer_group_id;
    if (groupId !== undefined && !scope.groupIds.has(String(groupId))) {
      throw this.violation(`multiplayer_group_id ${String(groupId)} was not started from a pinned place.`);
    }
    const cursors = args.cursor_by_instance;
    if (cursors && typeof cursors === 'object') {
      for (const id of Object.keys(cursors as Record<string, unknown>)) {
        const resolved = bridge.resolveConnectedInstanceId(id) ?? id;
        if (!scope.instanceIds.has(resolved) && !scope.instanceIds.has(id)) {
          throw this.violation(`cursor_by_instance names ${id}, which is not a pinned place.`);
        }
      }
    }
    if (instanceId === undefined && groupId === undefined) {
      if (scope.pinned.length === 0) throw this.violation(`${name} refused: no open place matches the pin.`);
      if (scope.pinned.length > 1) {
        throw this.violation(
          `${name} needs instance_id: ${scope.pinned.length} pinned places are open (${scope.pinned.map((i) => `${i.id} ${i.placeName}`).join('; ')}).`,
        );
      }
      return { ...args, instance_id: scope.pinned[0].id };
    }
    return args;
  }

  private checkManageInstance(
    bridge: BridgeService,
    args: Record<string, unknown>,
    allowed: ReadonlySet<string>,
  ): Record<string, unknown> {
    const action = String(args.action ?? '');
    if (MANAGE_READ_ONLY_ACTIONS.has(action) && args.instance_id === undefined) return args;
    if (action === 'launch') {
      const file = typeof args.local_place_file === 'string' ? args.local_place_file.split(/[\\/]/).pop() : undefined;
      const ok = args.source === 'local_file'
        ? this.acceptsPlace(file, undefined)
        : args.source === 'published_place' || args.source === 'place_revision'
          ? this.acceptsPlace(undefined, args.place_id)
          : false;
      if (!ok) throw this.violation('manage_instance launch refused: the place is not pinned.');
      return args;
    }
    if (args.instance_id === undefined) {
      if (action === 'authorize' || action === 'complete') return args; // resume by launch_id of an own launch
      throw this.violation(`manage_instance ${action} needs the instance_id of a pinned place.`);
    }
    const id = String(args.instance_id);
    const resolved = bridge.resolveConnectedInstanceId(id) ?? id;
    if (!allowed.has(resolved) && !allowed.has(id)) {
      throw this.violation(`manage_instance ${action} refused: ${id} is not a pinned place.`);
    }
    return args;
  }

  /** Filters a get_connected_instances result to the pinned places and their groups. */
  filterConnectedInstances(bridge: BridgeService): Record<string, unknown> {
    if (this.state.kind === 'open') {
      return {
        instances: bridge.getConnectedInstances(),
        multiplayerGroups: bridge.getConnectedMultiplayerGroups(),
      };
    }
    const scope = this.state.kind === 'pinned'
      ? this.allowedScope(bridge)
      : { instanceIds: new Set<string>(), groupIds: new Set<string>() };
    return {
      instances: bridge.getConnectedInstances().filter((instance) => scope.instanceIds.has(instance.id)),
      multiplayerGroups: bridge.getConnectedMultiplayerGroups().filter((group) => scope.groupIds.has(group.id)),
      pin: this.describe(),
    };
  }
}
