import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, afterEach, before, describe, it } from "node:test";
import { build } from "esbuild";
import { io as createClient } from "socket.io-client";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const clients = new Set();
let httpServer;
let realtimeServer;
let getGameInfo;
let port;
let buildDirectory;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function expectEvent(socket, eventName, timeout = 5_000) {
  return new Promise((resolveEvent, rejectEvent) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(eventName, onEvent);
      socket.off("connect_error", onConnectError);
    };
    const onEvent = (payload) => {
      cleanup();
      resolveEvent(payload);
    };
    const onConnectError = (error) => {
      cleanup();
      rejectEvent(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectEvent(new Error(`Timed out waiting for Socket.IO event "${eventName}"`));
    }, timeout);

    socket.once(eventName, onEvent);
    socket.once("connect_error", onConnectError);
  });
}

async function waitUntil(readValue, predicate, label, timeout = 5_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = readValue();
    if (predicate(value)) return value;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function connectClient() {
  const socket = createClient(`http://127.0.0.1:${port}`, {
    autoConnect: false,
    forceNew: true,
    path: "/api/socket.io",
    reconnection: false,
    transports: ["websocket"],
  });
  const client = {
    socket,
    joined: null,
    latestUpdate: null,
    updateCount: 0,
    id: null,
  };
  socket.on("playerUpdate", (update) => {
    client.latestUpdate = update;
    client.updateCount += 1;
  });
  clients.add(client);

  const joinedPromise = expectEvent(socket, "joined");
  socket.connect();
  client.joined = await joinedPromise;
  client.id = client.joined.playerId;
  return client;
}

async function disconnectClient(client) {
  if (!client?.socket.connected) return;
  const disconnected = expectEvent(client.socket, "disconnect");
  client.socket.disconnect();
  await disconnected;
}

function currentPlayer(client, id = client.id) {
  return client.latestUpdate?.players.find((player) => player.id === id);
}

function distanceToCar(player, car) {
  return Math.hypot(player.x - car.x, player.z - car.z);
}

async function moveNearCar(client, carId) {
  const car = client.joined.cars.find((candidate) => candidate.id === carId);
  assert.ok(car, `Expected ${carId} in the joined snapshot`);
  const player = client.joined.player;
  const distance = distanceToCar(player, car);
  if (distance > 4.5) {
    const rotation = Math.atan2(car.x - player.x, -(car.z - player.z));
    client.socket.emit("playerInput", { forward: true, rotation });
    await waitUntil(
      () => currentPlayer(client),
      (current) => current && distanceToCar(current, car) <= 4.5,
      `${client.id} to reach ${carId}`,
      15_000,
    );
    client.socket.emit("playerInput", { forward: false, rotation });
    await delay(100);
  }

  const current = currentPlayer(client);
  assert.ok(current && distanceToCar(current, car) <= 6, "Player should be within car range");
}

describe("realtime multiplayer sessions", () => {
  before(async () => {
    buildDirectory = await mkdtemp(join(packageRoot, ".test-build-"));
    const bundledModule = join(buildDirectory, "realtime-game.mjs");
    await build({
      bundle: true,
      entryPoints: [join(packageRoot, "src/lib/realtime-game.ts")],
      format: "esm",
      outfile: bundledModule,
      packages: "external",
      platform: "node",
    });
    const gameModule = await import(pathToFileURL(bundledModule).href);
    getGameInfo = gameModule.getGameInfo;

    httpServer = createServer();
    realtimeServer = gameModule.createRealtimeGame(httpServer);
    await new Promise((resolveListen, rejectListen) => {
      httpServer.once("error", rejectListen);
      httpServer.listen(0, "127.0.0.1", resolveListen);
    });
    port = httpServer.address().port;
  });

  afterEach(async () => {
    await Promise.all(Array.from(clients, disconnectClient));
    clients.clear();
  });

  after(async () => {
    if (realtimeServer) {
      await new Promise((resolveClose) => realtimeServer.close(resolveClose));
    }
    if (buildDirectory) {
      await rm(buildDirectory, { force: true, recursive: true });
    }
  });

  it("caps sessions at 10 players and removes disconnected players", async () => {
    const players = [];
    for (let index = 0; index < 10; index += 1) {
      players.push(await connectClient());
    }

    assert.equal(getGameInfo().onlinePlayers, 10);
    assert.equal(players[0].joined.players.length, 1);

    const rejectedSocket = createClient(`http://127.0.0.1:${port}`, {
      autoConnect: false,
      forceNew: true,
      path: "/api/socket.io",
      reconnection: false,
      transports: ["websocket"],
    });
    const fullEvent = expectEvent(rejectedSocket, "serverFull");
    const rejectedDisconnect = expectEvent(rejectedSocket, "disconnect");
    rejectedSocket.connect();
    const fullPayload = await fullEvent;
    await rejectedDisconnect;
    assert.match(fullPayload.message, /full/i);
    assert.equal(getGameInfo().onlinePlayers, 10);
    clients.add({ socket: rejectedSocket });

    await disconnectClient(players[0]);
    await waitUntil(
      () => players[1].latestUpdate,
      (update) =>
        update?.onlinePlayers === 9 &&
        !update.players.some((player) => player.id === players[0].id),
      "the disconnected player to be removed from the shared state",
    );
    assert.equal(getGameInfo().onlinePlayers, 9);
  });

  it("keeps car locks exclusive and releases a lock when its driver disconnects", async () => {
    const first = await connectClient();
    const second = await connectClient();
    const starts = [first.joined.player, second.joined.player];
    const candidateCars = first.joined.cars.filter((car) => !car.driverId);
    const car = candidateCars.reduce((best, candidate) => {
      const candidateMaxDistance = Math.max(
        ...starts.map((player) => distanceToCar(player, candidate)),
      );
      const bestMaxDistance = Math.max(
        ...starts.map((player) => distanceToCar(player, best)),
      );
      return candidateMaxDistance < bestMaxDistance ? candidate : best;
    });

    await Promise.all([moveNearCar(first, car.id), moveNearCar(second, car.id)]);
    first.socket.emit("enterCar", { carId: car.id });
    await waitUntil(
      () => first.latestUpdate,
      (update) =>
        update?.cars.find((candidate) => candidate.id === car.id)?.driverId === first.id,
      "the first player to acquire the car",
    );

    const updatesBeforeAttempt = second.updateCount;
    second.socket.emit("enterCar", { carId: car.id });
    await waitUntil(
      () => second.updateCount,
      (count) => count > updatesBeforeAttempt,
      "a world update after the second player tries the occupied car",
    );
    assert.equal(currentPlayer(second)?.carId, null);
    assert.equal(
      second.latestUpdate.cars.find((candidate) => candidate.id === car.id)?.driverId,
      first.id,
    );

    await disconnectClient(first);
    await waitUntil(
      () => second.latestUpdate,
      (update) =>
        update?.onlinePlayers === 1 &&
        !update.players.some((player) => player.id === first.id) &&
        update.cars.find((candidate) => candidate.id === car.id)?.driverId === null,
      "the car lock to be released after disconnect",
    );

    second.socket.emit("enterCar", { carId: car.id });
    await waitUntil(
      () => second.latestUpdate,
      (update) =>
        update?.cars.find((candidate) => candidate.id === car.id)?.driverId === second.id &&
        currentPlayer(second)?.carId === car.id,
      "the remaining player to acquire the released car",
    );
  });

  it("broadcasts chat messages to every player in the session", async () => {
    const sender = await connectClient();
    const recipient = await connectClient();
    const senderMessage = expectEvent(sender.socket, "chatMessage");
    const recipientMessage = expectEvent(recipient.socket, "chatMessage");

    sender.socket.emit("chatMessage", "Meet at the plaza");

    const [sent, received] = await Promise.all([senderMessage, recipientMessage]);
    assert.deepEqual(received, sent);
    assert.equal(sent.name, sender.joined.player.name);
    assert.equal(sent.text, "Meet at the plaza");
  });

  it("applies damage when a shot hits another player", async () => {
    const shooter = await connectClient();
    const target = await connectClient();
    await waitUntil(
      () => shooter.latestUpdate,
      (update) =>
        update?.players.some((player) => player.id === shooter.id) &&
        update.players.some((player) => player.id === target.id),
      "both players to appear in the live snapshot",
    );

    let shooterState = currentPlayer(shooter, shooter.id);
    let targetState = currentPlayer(shooter, target.id);
    let separation = Math.hypot(
      targetState.x - shooterState.x,
      targetState.z - shooterState.z,
    );

    if (separation > 2.5) {
      const rotation = Math.atan2(
        shooterState.x - targetState.x,
        -(shooterState.z - targetState.z),
      );
      target.socket.emit("playerInput", { forward: true, rotation });
      await waitUntil(
        () => shooter.latestUpdate,
        (update) => {
          const currentShooter = update?.players.find((player) => player.id === shooter.id);
          const currentTarget = update?.players.find((player) => player.id === target.id);
          return (
            currentShooter &&
            currentTarget &&
            Math.hypot(
              currentTarget.x - currentShooter.x,
              currentTarget.z - currentShooter.z,
            ) <= 2.5
          );
        },
        "the target to move into shooting range",
        15_000,
      );
      target.socket.emit("playerInput", { forward: false, rotation });
      await delay(100);
    }

    shooterState = currentPlayer(shooter, shooter.id);
    targetState = currentPlayer(shooter, target.id);
    separation = Math.hypot(
      targetState.x - shooterState.x,
      targetState.z - shooterState.z,
    );
    assert.ok(separation > 0.001 && separation <= 3, "Players should be aligned within range");

    const bullet = expectEvent(shooter.socket, "bulletFired");
    shooter.socket.emit("shoot", {
      origin: { x: shooterState.x, y: 1.45, z: shooterState.z },
      direction: {
        x: targetState.x - shooterState.x,
        y: -0.55,
        z: targetState.z - shooterState.z,
      },
    });
    const fired = await bullet;
    assert.equal(fired.playerId, shooter.id);

    await waitUntil(
      () => target.latestUpdate,
      (update) => update?.players.find((player) => player.id === target.id)?.health === 99,
      "the target's health to decrease after the shot",
    );
    assert.equal(currentPlayer(target)?.wanted, 1);
  });

  it("sends reconnecting players a fresh snapshot of the current session", async () => {
    const first = await connectClient();
    const second = await connectClient();
    assert.ok(second.joined.players.some((player) => player.id === first.id));
    assert.equal(second.joined.players.length, 2);
    assert.equal(second.joined.cars.length, 5);

    await disconnectClient(first);
    await waitUntil(
      () => second.latestUpdate,
      (update) =>
        update?.onlinePlayers === 1 &&
        !update.players.some((player) => player.id === first.id),
      "the previous session state to clear before reconnect",
    );

    const reconnected = await connectClient();
    assert.ok(reconnected.joined.players.some((player) => player.id === second.id));
    assert.ok(reconnected.joined.players.some((player) => player.id === reconnected.id));
    assert.ok(!reconnected.joined.players.some((player) => player.id === first.id));
    assert.equal(reconnected.joined.players.length, 2);
    assert.equal(reconnected.joined.cars.length, 5);
    assert.ok(reconnected.joined.cars.every((car) => car.driverId === null));
  });
});
