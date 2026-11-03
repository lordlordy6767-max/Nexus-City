import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";

const MAX_PLAYERS = 10;
const CITY_LIMIT = 195;
const TICK_MS = 50;
const PLAYER_COLORS = [
  "#57e6a2",
  "#ff6b6b",
  "#60a5fa",
  "#facc15",
  "#c084fc",
  "#fb923c",
  "#2dd4bf",
  "#f472b6",
  "#a3e635",
  "#e2e8f0",
];

export interface GamePlayer {
  id: string;
  name: string;
  color: string;
  x: number;
  z: number;
  rotation: number;
  carId: string | null;
  speed: number;
  health: number;
  money: number;
  kills: number;
  wanted: number;
}

export interface CarState {
  id: string;
  color: string;
  speed: number;
  velocity: number;
  x: number;
  z: number;
  rotation: number;
  driverId: string | null;
}

export interface PoliceState {
  id: string;
  x: number;
  z: number;
  rotation: number;
}

interface PlayerInput {
  forward?: boolean;
  backward?: boolean;
  left?: boolean;
  right?: boolean;
  sprint?: boolean;
  brake?: boolean;
  rotation?: number;
}

interface ShootInput {
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
}

interface ChatMessage {
  id: string;
  name: string;
  color: string;
  text: string;
  at: number;
}

interface PlayerRuntime {
  state: GamePlayer;
  input: PlayerInput;
  lastShotAt: number;
  lastChatAt: number;
  lastCrimeAt: number;
}

interface ClientToServerEvents {
  playerInput: (input: PlayerInput) => void;
  enterCar: (payload: { carId: string }) => void;
  exitCar: () => void;
  shoot: (payload: ShootInput) => void;
  chatMessage: (text: string) => void;
}

interface ServerToClientEvents {
  joined: (payload: {
    playerId: string;
    player: GamePlayer;
    players: GamePlayer[];
    cars: CarState[];
    police: PoliceState[];
  }) => void;
  playerUpdate: (payload: {
    players: GamePlayer[];
    cars: CarState[];
    police: PoliceState[];
    onlinePlayers: number;
  }) => void;
  chatMessage: (payload: ChatMessage) => void;
  bulletFired: (payload: {
    id: string;
    playerId: string;
    color: string;
    origin: { x: number; y: number; z: number };
    direction: { x: number; y: number; z: number };
  }) => void;
  serverFull: (payload: { message: string }) => void;
}

const players = new Map<string, PlayerRuntime>();
const cars = new Map<string, CarState>();
const police = new Map<string, PoliceState>();

const CAR_SPECS = [
  { id: "car-red", color: "#f05252", speed: 29, x: -40, z: 0, rotation: 0 },
  { id: "car-blue", color: "#3b82f6", speed: 34, x: 40, z: 0, rotation: Math.PI },
  {
    id: "car-yellow",
    color: "#facc15",
    speed: 26,
    x: 0,
    z: -40,
    rotation: Math.PI / 2,
  },
  {
    id: "car-black",
    color: "#202a39",
    speed: 37,
    x: 0,
    z: 40,
    rotation: -Math.PI / 2,
  },
  {
    id: "car-white",
    color: "#e8edf1",
    speed: 31,
    x: 80,
    z: 40,
    rotation: 0,
  },
] as const;

for (const car of CAR_SPECS) {
  cars.set(car.id, { ...car, velocity: 0, driverId: null });
}

function getPublicPlayers(): GamePlayer[] {
  return Array.from(players.values(), (runtime) => ({ ...runtime.state }));
}

function getPublicCars(): CarState[] {
  return Array.from(cars.values(), (car) => ({ ...car }));
}

function getPublicPolice(): PoliceState[] {
  return Array.from(police.values(), (cop) => ({ ...cop }));
}

function snapshot() {
  return {
    players: getPublicPlayers(),
    cars: getPublicCars(),
    police: getPublicPolice(),
    onlinePlayers: players.size,
  };
}

export function getGameInfo() {
  return {
    name: "NEXUS CITY ONLINE",
    onlinePlayers: players.size,
    maxPlayers: MAX_PLAYERS,
    availableCars: cars.size,
    citySize: 400,
    tickRate: 20,
  };
}

function randomSpawn() {
  return {
    x: Math.round((Math.random() * 24 - 12) * 10) / 10,
    z: Math.round((Math.random() * 24 - 12) * 10) / 10,
  };
}

function clampCity(value: number) {
  return Math.max(-CITY_LIMIT, Math.min(CITY_LIMIT, value));
}

function normalizeDirection(input: ShootInput["direction"]) {
  const length = Math.hypot(input.x, input.y, input.z);
  if (!Number.isFinite(length) || length < 0.001) return null;
  return { x: input.x / length, y: input.y / length, z: input.z / length };
}

function spawnPoliceForWantedPlayers() {
  const wantedTargets = Array.from(players.values())
    .map((runtime) => runtime.state)
    .filter((player) => player.wanted >= 2);

  for (const target of wantedTargets) {
    if (!police.has(target.id)) {
      police.set(target.id, {
        id: `police-${target.id}`,
        x: 7,
        z: -4,
        rotation: 0,
      });
    }
  }

  for (const targetId of police.keys()) {
    if (!wantedTargets.some((player) => player.id === targetId)) {
      police.delete(targetId);
    }
  }
}

function hitPlayer(shooter: GamePlayer, origin: ShootInput["origin"], direction: NonNullable<ReturnType<typeof normalizeDirection>>) {
  let nearest: { player: GamePlayer; distance: number } | undefined;

  for (const runtime of players.values()) {
    const target = runtime.state;
    if (target.id === shooter.id) continue;

    const targetY = target.carId ? 0.55 : 0.9;
    const dx = target.x - origin.x;
    const dy = targetY - origin.y;
    const dz = target.z - origin.z;
    const along = dx * direction.x + dy * direction.y + dz * direction.z;
    if (along <= 0 || along > 70) continue;

    const closestX = origin.x + direction.x * along;
    const closestY = origin.y + direction.y * along;
    const closestZ = origin.z + direction.z * along;
    const radius = target.carId ? 1.9 : 1.15;
    const distance = Math.hypot(
      target.x - closestX,
      targetY - closestY,
      target.z - closestZ,
    );
    if (distance <= radius && (!nearest || along < nearest.distance)) {
      nearest = { player: target, distance: along };
    }
  }

  return nearest?.player;
}

function movePlayer(runtime: PlayerRuntime, dt: number) {
  const player = runtime.state;
  const input = runtime.input;
  const rotation = Number(input.rotation);
  if (Number.isFinite(rotation)) player.rotation = rotation;

  if (player.carId) {
    const car = cars.get(player.carId);
    if (!car || car.driverId !== player.id) {
      player.carId = null;
      player.speed = 0;
      return;
    }

    const turn = Number(Boolean(input.right)) - Number(Boolean(input.left));
    if (Math.abs(car.velocity) > 0.1) {
      car.rotation += turn * dt * Math.min(1.2, Math.abs(car.velocity) / 14) * Math.sign(car.velocity);
    }

    if (input.brake) {
      car.velocity *= Math.max(0, 1 - dt * 5.5);
    } else if (input.forward) {
      car.velocity = Math.min(car.speed, car.velocity + dt * 17);
    } else if (input.backward) {
      if (car.velocity > 0.5) car.velocity = Math.max(0, car.velocity - dt * 22);
      else car.velocity = Math.max(-8, car.velocity - dt * 12);
    } else {
      car.velocity *= Math.max(0, 1 - dt * 1.3);
    }

    car.x = clampCity(car.x + Math.sin(car.rotation) * car.velocity * dt);
    car.z = clampCity(car.z - Math.cos(car.rotation) * car.velocity * dt);
    player.x = car.x;
    player.z = car.z;
    player.rotation = car.rotation;
    player.speed = Math.round(Math.abs(car.velocity) * 10) / 10;
    return;
  }

  const forward = Number(Boolean(input.forward)) - Number(Boolean(input.backward));
  const strafe = Number(Boolean(input.right)) - Number(Boolean(input.left));
  const forwardX = Math.sin(player.rotation);
  const forwardZ = -Math.cos(player.rotation);
  const rightX = Math.cos(player.rotation);
  const rightZ = Math.sin(player.rotation);
  let moveX = forwardX * forward + rightX * strafe;
  let moveZ = forwardZ * forward + rightZ * strafe;
  const magnitude = Math.hypot(moveX, moveZ);
  if (magnitude > 1) {
    moveX /= magnitude;
    moveZ /= magnitude;
  }
  const speed = input.sprint ? 7.3 : 4.5;
  player.x = clampCity(player.x + moveX * speed * dt);
  player.z = clampCity(player.z + moveZ * speed * dt);
  player.speed = Math.hypot(moveX, moveZ) * speed;
}

function updatePolice(dt: number) {
  spawnPoliceForWantedPlayers();

  for (const [targetId, cop] of police) {
    const target = players.get(targetId)?.state;
    if (!target) {
      police.delete(targetId);
      continue;
    }

    const dx = target.x - cop.x;
    const dz = target.z - cop.z;
    const distance = Math.hypot(dx, dz);
    if (distance > 0.2) {
      cop.rotation = Math.atan2(dx, -dz);
      const step = Math.min(distance, dt * 8.5);
      cop.x = clampCity(cop.x + (dx / distance) * step);
      cop.z = clampCity(cop.z + (dz / distance) * step);
    }
  }
}

function emitWorldState(io: Server<ClientToServerEvents, ServerToClientEvents>) {
  io.emit("playerUpdate", snapshot());
}

export function createRealtimeGame(httpServer: HttpServer) {
  const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
    path: "/api/socket.io",
    cors: { origin: true, methods: ["GET", "POST"] },
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    if (players.size >= MAX_PLAYERS) {
      socket.emit("serverFull", { message: "This city is full. Try again soon." });
      socket.disconnect(true);
      return;
    }

    const occupiedNames = new Set(
      Array.from(players.values(), (runtime) => runtime.state.name),
    );
    let playerNumber = 1;
    while (occupiedNames.has(`Player${playerNumber}`)) playerNumber += 1;
    const spawn = randomSpawn();
    const state: GamePlayer = {
      id: socket.id,
      name: `Player${playerNumber}`,
      color: PLAYER_COLORS[Math.floor(Math.random() * PLAYER_COLORS.length)]!,
      ...spawn,
      rotation: Math.random() * Math.PI * 2,
      carId: null,
      speed: 0,
      health: 100,
      money: 500,
      kills: 0,
      wanted: 0,
    };

    const runtime: PlayerRuntime = {
      state,
      input: {},
      lastShotAt: 0,
      lastChatAt: 0,
      lastCrimeAt: 0,
    };
    players.set(socket.id, runtime);
    socket.emit("joined", {
      playerId: socket.id,
      player: { ...state },
      players: getPublicPlayers(),
      cars: getPublicCars(),
      police: getPublicPolice(),
    });
    emitWorldState(io);

    socket.on("playerInput", (input) => {
      runtime.input = {
        forward: input?.forward === true,
        backward: input?.backward === true,
        left: input?.left === true,
        right: input?.right === true,
        sprint: input?.sprint === true,
        brake: input?.brake === true,
        rotation: Number(input?.rotation),
      };
    });

    socket.on("enterCar", (payload) => {
      if (runtime.state.carId || typeof payload?.carId !== "string") return;
      const car = cars.get(payload.carId);
      if (!car || car.driverId) return;
      if (Math.hypot(car.x - state.x, car.z - state.z) > 6) return;

      car.driverId = state.id;
      car.velocity = 0;
      state.carId = car.id;
      state.x = car.x;
      state.z = car.z;
      state.rotation = car.rotation;
      emitWorldState(io);
    });

    socket.on("exitCar", () => {
      if (!state.carId) return;
      const car = cars.get(state.carId);
      if (car?.driverId === state.id) {
        car.driverId = null;
        car.velocity = 0;
        state.x = clampCity(car.x + Math.cos(car.rotation) * 2.7);
        state.z = clampCity(car.z + Math.sin(car.rotation) * 2.7);
      }
      state.carId = null;
      state.speed = 0;
      runtime.input = {};
      emitWorldState(io);
    });

    socket.on("shoot", (payload) => {
      const now = Date.now();
      if (now - runtime.lastShotAt < 320) return;
      runtime.lastShotAt = now;

      const direction = normalizeDirection(payload?.direction);
      if (!direction) return;
      const origin = {
        x: state.x,
        y: state.carId ? 1.1 : 1.45,
        z: state.z,
      };
      state.wanted = Math.min(5, state.wanted + 1);
      runtime.lastCrimeAt = now;
      io.emit("bulletFired", {
        id: randomUUID(),
        playerId: state.id,
        color: state.color,
        origin,
        direction,
      });

      const target = hitPlayer(state, origin, direction);
      if (target) {
        target.health = Math.max(0, target.health - 1);
        target.wanted = Math.min(5, Math.max(target.wanted, 1));
        const targetRuntime = players.get(target.id);
        if (targetRuntime) targetRuntime.lastCrimeAt = now;

        if (target.health === 0) {
          state.kills += 1;
          state.money += 100;
          target.health = 100;
          const respawn = randomSpawn();
          target.x = respawn.x;
          target.z = respawn.z;
          target.wanted = Math.min(5, target.wanted + 1);
          if (target.carId) {
            const car = cars.get(target.carId);
            if (car) {
              car.driverId = null;
              car.velocity = 0;
            }
            target.carId = null;
          }
        }
      }
      emitWorldState(io);
    });

    socket.on("chatMessage", (rawText) => {
      const now = Date.now();
      if (now - runtime.lastChatAt < 450 || typeof rawText !== "string") return;
      const text = rawText.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 160);
      if (!text) return;
      runtime.lastChatAt = now;
      io.emit("chatMessage", {
        id: randomUUID(),
        name: state.name,
        color: state.color,
        text,
        at: now,
      });
    });

    socket.on("disconnect", () => {
      if (state.carId) {
        const car = cars.get(state.carId);
        if (car?.driverId === state.id) {
          car.driverId = null;
          car.velocity = 0;
        }
      }
      players.delete(state.id);
      police.delete(state.id);
      emitWorldState(io);
    });
  });

  let previousTick = Date.now();
  const tick = setInterval(() => {
    const now = Date.now();
    const dt = Math.min(0.1, (now - previousTick) / 1000);
    previousTick = now;

    for (const runtime of players.values()) {
      movePlayer(runtime, dt);
      if (runtime.state.wanted > 0 && now - runtime.lastCrimeAt > 30_000) {
        runtime.state.wanted = Math.max(0, runtime.state.wanted - 1);
        runtime.lastCrimeAt = now;
      }
    }

    updatePolice(dt);
    emitWorldState(io);
  }, TICK_MS);
  tick.unref();

  return io;
}
