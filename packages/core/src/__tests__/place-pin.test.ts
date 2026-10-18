import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { BridgeService } from '../bridge-service.js';
import { createHttpServer } from '../http-server.js';
import { publicToolErrorBody } from '../mcp-runtime.js';
import { keyMatchesPlace, parsePinKeys, PinViolationError, PlacePinGuard } from '../place-pin.js';
import { RobloxStudioTools } from '../tools/index.js';
import { TOOL_DEFINITIONS } from '../tools/definitions.js';
import { MacStudioCloseUnsupportedError, StudioInstanceManager } from '../studio-instance-manager.js';
import type { ManagedStudioInstance } from '../studio-instance-manager.js';

function register(
  bridge: BridgeService,
  instanceId: string,
  role: string,
  placeName: string,
  placeId = 0,
  group?: string,
) {
  const peerId = `peer:${instanceId}:${role}`;
  const result = bridge.registerPeer({
    peerId, transportPeerId: peerId, instanceId, role, multiplayerGroupId: group,
    placeId, placeName, dataModelName: placeName, isRunning: role !== 'edit',
  });
  if (!result.ok) throw new Error(result.error.message);
}

/** Two agents' places: A (OneMoreFloor QA copy, solo Play running) and B (another project). */
function topology() {
  const bridge = new BridgeService();
  register(bridge, 'instance:a', 'edit', 'OneMoreFloor-m1-cache-QA.rbxl');
  register(bridge, 'instance:a', 'server', 'OneMoreFloor-m1-cache-QA.rbxl');
  register(bridge, 'instance:a', 'client-1', 'OneMoreFloor-m1-cache-QA.rbxl');
  register(bridge, 'instance:b', 'edit', 'UITemplates-qa.rbxl', 101326133712692);
  return bridge;
}

const guard = (env: Record<string, string>) => new PlacePinGuard(TOOL_DEFINITIONS, env);

describe('place pin keys', () => {
  test('parses comma lists and arrays, ignoring blanks', () => {
    expect(parsePinKeys(' A* , B.rbxl,,123 ')).toEqual(['A*', 'B.rbxl', '123']);
    expect(parsePinKeys(['A*,B*', 42])).toEqual(['A*', 'B*', '42']);
    expect(parsePinKeys(undefined)).toEqual([]);
  });

  test('matches exact names, prefixes and place ids like roblox-studio-mcp 0.3', () => {
    expect(keyMatchesPlace('Game*', 'Game-QA.rbxl', 0)).toBe(true);
    expect(keyMatchesPlace('Game*', 'OtherGame.rbxl', 0)).toBe(false);
    expect(keyMatchesPlace('*', 'Anything.rbxl', 0)).toBe(false);
    expect(keyMatchesPlace('Game.rbxl', 'Game.rbxl', 0)).toBe(true);
    expect(keyMatchesPlace('Game.rbxl', 'Game-QA.rbxl', 0)).toBe(false);
    expect(keyMatchesPlace('101326133712692', 'Place1', 101326133712692)).toBe(true);
    expect(keyMatchesPlace('0', 'Unsaved', 0)).toBe(false);
  });
});

describe('PlacePinGuard', () => {
  test('unpinned and not required: passes every call through unchanged', async () => {
    const bridge = topology();
    const g = guard({});
    const args = { code: 'return 1', instance_id: 'instance:b' };
    await expect(g.check(bridge, 'execute_luau', args)).resolves.toBe(args);
    expect((g.filterConnectedInstances(bridge).instances as unknown[]).length).toBe(2);
  });

  test('injects the single pinned instance when instance_id is absent', async () => {
    const bridge = topology();
    const g = guard({ ROBLOX_STUDIO_PLACE: 'OneMoreFloor*' });
    await expect(g.check(bridge, 'execute_luau', { code: 'return 1' }))
      .resolves.toEqual({ code: 'return 1', instance_id: 'instance:a' });
  });

  test('allows its own place and its playtest peers, refuses another place with pin_violation', async () => {
    const bridge = topology();
    const g = guard({ ROBLOX_STUDIO_PLACE: 'OneMoreFloor*' });
    await expect(g.check(bridge, 'solo_playtest', { action: 'status', instance_id: 'instance:a' })).resolves.toBeDefined();
    const refused = g.check(bridge, 'execute_luau', { code: 'return 1', instance_id: 'instance:b' });
    await expect(refused).rejects.toBeInstanceOf(PinViolationError);
    await expect(refused).rejects.toThrow('instance_id instance:b is not a pinned place');
    await expect(g.check(bridge, 'get_runtime_logs', { cursor_by_instance: { 'instance:b': 1 } }))
      .rejects.toThrow('cursor_by_instance names instance:b');
    await expect(g.check(bridge, 'execute_luau', { code: 'x', instance_id: 'instance:unknown' }))
      .rejects.toThrow('not a pinned place');
  });

  test('pins by numeric place id', async () => {
    const bridge = topology();
    const g = guard({ ROBLOX_STUDIO_PLACE: '101326133712692' });
    await expect(g.check(bridge, 'get_place_info', {})).resolves.toEqual({ instance_id: 'instance:b' });
  });

  test('allows a multiplayer group started from the pinned place and its runtime instances', async () => {
    const bridge = new BridgeService();
    register(bridge, 'instance:a', 'edit', 'OneMoreFloor-m1-cache-QA.rbxl');
    register(bridge, 'instance:b', 'edit', 'UITemplates-qa.rbxl', 101326133712692);
    bridge.createMultiplayerGroup('group:a', 'instance:a');
    register(bridge, 'instance:a-srv', 'server', 'Server', 0, 'group:a');
    register(bridge, 'instance:a-c1', 'client-1', 'Server', 0, 'group:a');
    bridge.createMultiplayerGroup('group:b', 'instance:b');
    const g = guard({ ROBLOX_STUDIO_PLACE: 'OneMoreFloor*' });
    await expect(g.check(bridge, 'get_runtime_logs', { multiplayer_group_id: 'group:a' })).resolves.toBeDefined();
    await expect(g.check(bridge, 'eval_server_runtime', { code: 'x', instance_id: 'instance:a-srv' })).resolves.toBeDefined();
    await expect(g.check(bridge, 'get_runtime_logs', { multiplayer_group_id: 'group:b' }))
      .rejects.toThrow('was not started from a pinned place');
    const listed = g.filterConnectedInstances(bridge);
    expect((listed.multiplayerGroups as { id: string }[]).map((group) => group.id)).toEqual(['group:a']);
  });

  test('get_connected_instances lists only pinned places', () => {
    const bridge = topology();
    const g = guard({ ROBLOX_STUDIO_PLACE: 'UITemplates*' });
    const listed = g.filterConnectedInstances(bridge);
    expect((listed.instances as { id: string }[]).map((instance) => instance.id)).toEqual(['instance:b']);
    expect(listed.pin).toEqual({ pinned: true, keys: ['UITemplates*'] });
  });

  test('ROBLOX_STUDIO_REQUIRE_PIN=1 refuses Studio tools until pin_place, then serves the pin', async () => {
    const bridge = topology();
    const g = guard({ ROBLOX_STUDIO_REQUIRE_PIN: '1' });
    await expect(g.check(bridge, 'execute_luau', { code: 'x', instance_id: 'instance:a' }))
      .rejects.toThrow('no place is pinned');
    expect(g.filterConnectedInstances(bridge).instances).toEqual([]);
    // Tools that never reach Studio stay available.
    await expect(g.check(bridge, 'search_docs', { query: 'x' })).resolves.toEqual({ query: 'x' });
    g.setPin(['OneMoreFloor*']);
    await expect(g.check(bridge, 'execute_luau', { code: 'x' })).resolves.toEqual({ code: 'x', instance_id: 'instance:a' });
    expect(() => g.setPin([])).toThrow('at least one place key');
  });

  test('requires instance_id when the pin matches several open places, and refuses when none is open', async () => {
    const bridge = topology();
    register(bridge, 'instance:a2', 'edit', 'OneMoreFloor-m1-threats-QA.rbxl');
    const g = guard({ ROBLOX_STUDIO_PLACE: 'OneMoreFloor*' });
    await expect(g.check(bridge, 'execute_luau', { code: 'x' })).rejects.toThrow('needs instance_id: 2 pinned places');
    await expect(g.check(bridge, 'execute_luau', { code: 'x', instance_id: 'instance:a2' })).resolves.toBeDefined();
    const none = guard({ ROBLOX_STUDIO_PLACE: 'EggDuty*' });
    await expect(none.check(bridge, 'execute_luau', { code: 'x' })).rejects.toThrow('no open place matches the pin');
  });

  test('manage_instance: launch only pinned files, close only pinned instances, status always', async () => {
    const bridge = topology();
    const g = guard({ ROBLOX_STUDIO_PLACE: 'OneMoreFloor*' });
    await expect(g.check(bridge, 'manage_instance', { action: 'status' })).resolves.toEqual({ action: 'status' });
    await expect(g.check(bridge, 'manage_instance', {
      action: 'launch', source: 'local_file', local_place_file: '/x/OneMoreFloor/build/OneMoreFloor-QA.rbxl',
    })).resolves.toBeDefined();
    await expect(g.check(bridge, 'manage_instance', {
      action: 'launch', source: 'local_file', local_place_file: '/x/UITemplates.rbxl',
    })).rejects.toThrow('launch refused');
    await expect(g.check(bridge, 'manage_instance', { action: 'launch', source: 'baseplate' })).rejects.toThrow('launch refused');
    await expect(g.check(bridge, 'manage_instance', { action: 'close', instance_id: 'instance:b' })).rejects.toThrow('close refused');
    await expect(g.check(bridge, 'manage_instance', { action: 'close', instance_id: 'instance:a' })).resolves.toBeDefined();
  });

  test('pin violations surface as a pin_violation tool error', () => {
    const body = publicToolErrorBody('execute_luau', new PinViolationError('nope', ['A*']));
    expect(body).toEqual({ error: 'pin_violation', message: 'nope', pin: ['A*'] });
  });

  test('every Studio-routed tool definition is guarded', () => {
    const bridge = new BridgeService();
    const g = guard({ ROBLOX_STUDIO_REQUIRE_PIN: '1' });
    const routed = TOOL_DEFINITIONS.filter((definition) => {
      const properties = (definition.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      return 'instance_id' in properties || 'multiplayer_group_id' in properties;
    });
    expect(routed.length).toBeGreaterThan(30);
    return Promise.all(routed.filter((d) => d.name !== 'manage_instance').map((d) =>
      expect(g.check(bridge, d.name, {})).rejects.toBeInstanceOf(PinViolationError)));
  });
});

describe('/health redaction', () => {
  const bridge = new BridgeService();
  register(bridge, 'instance:secret', 'edit', 'SecretPlace.rbxl');
  const tools = new RobloxStudioTools(bridge);
  const config = { name: 'robloxstudio-mcp', version: '3.2.1-dallen.1', tools: TOOL_DEFINITIONS };

  afterAll(async () => { await tools.dispose(); });

  test('tokenless callers get liveness only, no place names or ids', async () => {
    const app = createHttpServer(tools, bridge, undefined, config, { authToken: 'tok' });
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toMatchObject({ status: 'ok', pluginConnected: true, instanceCount: 1, version: '3.2.1-dallen.1' });
    expect(JSON.stringify(res.body)).not.toContain('SecretPlace');
    expect(JSON.stringify(res.body)).not.toContain('instance:secret');
    await app.cleanup();
  });

  test('token holders still see instances', async () => {
    const app = createHttpServer(tools, bridge, undefined, config, { authToken: 'tok' });
    const res = await request(app).get('/health').set('X-MCP-Auth', 'tok').expect(200);
    expect(JSON.stringify(res.body.instances)).toContain('SecretPlace');
    const wrong = await request(app).get('/health').set('X-MCP-Auth', 'bad').expect(200);
    expect(wrong.body.instances).toBeUndefined();
    await app.cleanup();
  });
});

describe('macOS manage_instance close', () => {
  test('refuses before signalling and points at studio.sh close', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-mac-close-'));
    const kill = jest.spyOn(process, 'kill');
    try {
      const pid = 999_991;
      const manager = new StudioInstanceManager({
        registryDir,
        closeTimeoutMs: 1000,
        processAdapter: {
          currentBootId: () => 'boot',
          listStudioProcesses: () => [{ Id: pid, Name: 'RobloxStudio', Path: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio', StartTimeUtcFileTime: '1' }],
        },
      });
      const record: ManagedStudioInstance = {
        recordId: 'mac-close', source: 'local_file', nativeProcessId: pid, nativeProcessStartedAt: '1', spawnPid: pid,
        exe: '/Applications/RobloxStudio.app/Contents/MacOS/RobloxStudio', args: [], launchedAt: Date.now(),
        state: 'connected', instanceId: 'instance:mac', bootId: 'boot', processAuthorizationState: 'released',
        processObservationStatus: 'running',
      };
      const closing = manager.close(record);
      await expect(closing).rejects.toBeInstanceOf(MacStudioCloseUnsupportedError);
      await expect(closing).rejects.toThrow('studio.sh close');
      expect(kill.mock.calls.filter(([, signal]) => signal === 'SIGTERM' || signal === 'SIGKILL')).toEqual([]);
    } finally {
      kill.mockRestore();
      Object.defineProperty(process, 'platform', platform);
      fs.rmSync(registryDir, { recursive: true, force: true });
    }
  });
});
