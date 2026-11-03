import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import * as THREE from 'three';
import { io, type Socket } from 'socket.io-client';
import { useGetGameInfo } from '@workspace/api-client-react';
import { Activity, CarFront, Heart, MapPin, MessageCircle, Send, Shield, Trophy, Wifi } from 'lucide-react';
import { TouchJoystick } from './components/touch-joystick';

type Player = {
  id: string; name: string; color: string; x: number; z: number; rotation: number;
  carId: string | null; speed: number; health: number; money: number; kills: number; wanted: number;
};
type Car = { id: string; color: string; speed: number; velocity: number; x: number; z: number; rotation: number; driverId: string | null };
type Police = { x: number; z: number; rotation: number };
type ChatLine = { id: string; name: string; color: string; text: string; at: string | number };
type GameInput = { forward: boolean; backward: boolean; left: boolean; right: boolean; sprint: boolean; brake: boolean; rotation: number };
type Snapshot = { players: Player[]; cars: Car[]; police: Police[] };
type SceneProps = Snapshot & { localPlayerId: string | null; yaw: number };

const EMPTY_SNAPSHOT: Snapshot = { players: [], cars: [], police: [] };
const WORLD_EXTENT = 200;
const STICK_DEADZONE = .3;
const LOOK_SPEED = .09;
const keyInput = { forward: false, backward: false, left: false, right: false, sprint: false, brake: false };

function colorOf(color: string, fallback: string) {
  try { return new THREE.Color(color); } catch { return new THREE.Color(fallback); }
}

function makeLabel(text: string, color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 112;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new THREE.Sprite();
  ctx.fillStyle = 'rgba(13,24,27,.86)';
  ctx.beginPath();
  ctx.roundRect(34, 16, 444, 78, 12);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.font = '700 38px Manrope, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#f1eee2';
  ctx.fillText(text.slice(0, 20), 256, 56, 400);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  sprite.scale.set(3.8, .83, 1);
  return sprite;
}

function startCanvasFallback(
  root: HTMLDivElement,
  liveProps: React.MutableRefObject<SceneProps>,
) {
  const canvas = document.createElement('canvas');
  canvas.className = 'city-fallback';
  canvas.setAttribute('aria-label', 'Nexus City low-poly fallback scene');
  const context = canvas.getContext('2d');
  if (!context) {
    root.textContent = 'This browser could not start a graphics canvas.';
    return () => { root.textContent = ''; };
  }
  root.appendChild(canvas);

  const buildings: { x: number; z: number; width: number; depth: number; height: number; color: string }[] = [];
  const palette = ['#c58b63', '#d5b17b', '#9aab97', '#b9c0a4', '#d0a578', '#8e9e98', '#c3a48b'];
  const seeded = (x: number, z: number, k: number) => {
    const value = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
    return value - Math.floor(value);
  };
  for (let gx = -5; gx < 5; gx++) {
    for (let gz = -5; gz < 5; gz++) {
      buildings.push({
        x: gx * 40 + 20,
        z: gz * 40 + 20,
        width: 15 + seeded(gx, gz, 1) * 10,
        depth: 15 + seeded(gx, gz, 2) * 10,
        height: 7 + seeded(gx, gz, 3) * 35,
        color: palette[Math.floor(seeded(gx, gz, 4) * palette.length)]!,
      });
    }
  }
  const bullets: { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number }; born: number; color: string }[] = [];
  const onBullet = (event: Event) => {
    const bullet = (event as CustomEvent<{ origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number }; color: string }>).detail;
    if (bullet) bullets.push({ ...bullet, born: performance.now() });
  };
  window.addEventListener('nexus-bullet', onBullet);

  let frame = 0;
  let width = 1;
  let height = 1;
  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 1.5);
    width = Math.max(1, root.clientWidth);
    height = Math.max(1, root.clientHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };
  window.addEventListener('resize', resize);
  resize();

  type Point = { x: number; y: number; depth: number; scale: number };
  const polygon = (points: Point[], color: string) => {
    if (points.length < 3) return;
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (let i = 1; i < points.length; i++) context.lineTo(points[i]!.x, points[i]!.y);
    context.closePath();
    context.fillStyle = color;
    context.fill();
  };
  const render = () => {
    const props = liveProps.current;
    const local = props.players.find((player) => player.id === props.localPlayerId);
    const center = local || { x: 0, z: 0 };
    const yaw = props.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const horizon = height * 0.3;
    const focal = Math.min(width, height) * 0.82;
    const project = (x: number, z: number, elevation = 0): Point | null => {
      const dx = x - center.x;
      const dz = z - center.z;
      const forward = dx * sin - dz * cos;
      const side = dx * cos + dz * sin;
      const depth = forward + 18;
      if (depth < 2) return null;
      const scale = focal / depth;
      return {
        x: width / 2 + side * scale,
        y: horizon + focal * 13 / depth - elevation * scale,
        depth,
        scale,
      };
    };

    const sky = context.createLinearGradient(0, 0, 0, height * 0.62);
    sky.addColorStop(0, '#7f9d98');
    sky.addColorStop(0.63, '#c5b18d');
    sky.addColorStop(1, '#d5b27f');
    context.fillStyle = sky;
    context.fillRect(0, 0, width, height);
    const ground = context.createLinearGradient(0, horizon, 0, height);
    ground.addColorStop(0, '#91a17f');
    ground.addColorStop(1, '#526e61');
    context.fillStyle = ground;
    context.fillRect(0, horizon, width, height - horizon);

    const road = (points: [number, number][], color: string) => {
      const projected = points.map(([x, z]) => project(x, z)).filter((point): point is Point => point !== null);
      if (projected.length === points.length) polygon(projected, color);
    };
    for (let lane = -5; lane <= 5; lane++) {
      const pos = lane * 40;
      road([[pos - 4, -220], [pos + 4, -220], [pos + 4, 220], [pos - 4, 220]], '#59645e');
      road([[-220, pos - 4], [220, pos - 4], [220, pos + 4], [-220, pos + 4]], '#59645e');
      if (lane !== 0) {
        road([[pos - 0.08, -220], [pos + 0.08, -220], [pos + 0.08, 220], [pos - 0.08, 220]], '#d6c99f');
        road([[-220, pos - 0.08], [220, pos - 0.08], [220, pos + 0.08], [-220, pos + 0.08]], '#d6c99f');
      }
    }

    const visibleBuildings = buildings
      .map((building) => ({ building, point: project(building.x, building.z) }))
      .filter((item): item is { building: typeof buildings[number]; point: Point } => item.point !== null)
      .sort((a, b) => b.point.depth - a.point.depth);
    for (const { building, point } of visibleBuildings) {
      const corners = [
        project(building.x - building.width / 2, building.z - building.depth / 2),
        project(building.x + building.width / 2, building.z - building.depth / 2),
        project(building.x + building.width / 2, building.z + building.depth / 2),
        project(building.x - building.width / 2, building.z + building.depth / 2),
      ];
      if (corners.some((corner) => !corner)) continue;
      const top = [
        project(building.x - building.width / 2, building.z - building.depth / 2, building.height),
        project(building.x + building.width / 2, building.z - building.depth / 2, building.height),
        project(building.x + building.width / 2, building.z + building.depth / 2, building.height),
        project(building.x - building.width / 2, building.z + building.depth / 2, building.height),
      ];
      if (top.some((corner) => !corner)) continue;
      const base = corners as Point[];
      const roof = top as Point[];
      polygon([base[1]!, base[2]!, roof[2]!, roof[1]!], 'rgba(29,43,40,.48)');
      polygon([base[0]!, base[1]!, roof[1]!, roof[0]!], building.color);
      polygon(roof, '#75685a');
      context.strokeStyle = 'rgba(30,42,38,.35)';
      context.lineWidth = Math.max(0.6, point.scale * 0.035);
      context.stroke();
      const windowWidth = Math.max(2, point.scale * 0.22);
      if (windowWidth > 2.5) {
        context.fillStyle = 'rgba(224,203,148,.7)';
        context.fillRect((roof[0]!.x + roof[1]!.x) / 2 - windowWidth / 2, (base[0]!.y + roof[0]!.y) / 2, windowWidth, Math.max(2, point.scale * 0.5));
      }
    }

    const drawCar = (car: Car) => {
      const point = project(car.x, car.z, 0.65);
      if (!point) return;
      const angle = car.rotation - yaw;
      const carWidth = Math.max(5, point.scale * 1.55);
      const carLength = Math.max(9, point.scale * 2.6);
      context.save();
      context.translate(point.x, point.y);
      context.rotate(angle);
      context.fillStyle = 'rgba(16,25,25,.38)';
      context.fillRect(-carWidth * .65, -carLength * .4, carWidth * 1.3, carLength * 1.15);
      context.fillStyle = car.color;
      context.fillRect(-carWidth / 2, -carLength / 2, carWidth, carLength);
      context.fillStyle = 'rgba(26,51,55,.78)';
      context.fillRect(-carWidth * .34, -carLength * .16, carWidth * .68, carLength * .34);
      context.restore();
    };
    props.cars.forEach(drawCar);

    const drawPlayer = (player: Player) => {
      const point = project(player.x, player.z, 0.95);
      if (!point) return;
      const size = Math.max(3, Math.min(16, point.scale * .48));
      context.fillStyle = 'rgba(13,23,24,.45)';
      context.beginPath();
      context.ellipse(point.x, point.y + size * 1.5, size * .8, size * .26, 0, 0, Math.PI * 2);
      context.fill();
      context.fillStyle = player.color;
      context.fillRect(point.x - size * .46, point.y - size * .2, size * .92, size * 1.4);
      context.fillStyle = '#f1d5b0';
      context.beginPath();
      context.arc(point.x, point.y - size * .55, size * .42, 0, Math.PI * 2);
      context.fill();
      context.font = `600 ${Math.max(9, Math.min(13, size * 1.05))}px Manrope, sans-serif`;
      context.textAlign = 'center';
      context.fillStyle = '#f3eddb';
      context.fillText(player.name, point.x, point.y - size * 1.25);
    };
    props.players.filter((player) => !player.carId).forEach(drawPlayer);

    for (const cop of props.police) {
      const point = project(cop.x, cop.z, 0.45);
      if (!point) continue;
      context.fillStyle = '#223f62';
      context.fillRect(point.x - 7, point.y - 5, 14, 12);
      context.fillStyle = '#e85b52';
      context.fillRect(point.x - 4, point.y - 6, 4, 2);
      context.fillStyle = '#8bd4ec';
      context.fillRect(point.x, point.y - 6, 4, 2);
    }

    const now = performance.now();
    for (let index = bullets.length - 1; index >= 0; index--) {
      const bullet = bullets[index]!;
      const travel = (now - bullet.born) / 1000 * 32;
      if (travel > 70) { bullets.splice(index, 1); continue; }
      const point = project(
        bullet.origin.x + bullet.direction.x * travel,
        bullet.origin.z + bullet.direction.z * travel,
        bullet.origin.y + bullet.direction.y * travel,
      );
      if (!point) continue;
      context.fillStyle = bullet.color;
      context.beginPath();
      context.arc(point.x, point.y, Math.max(2, point.scale * .12), 0, Math.PI * 2);
      context.fill();
    }

    frame = requestAnimationFrame(render);
  };
  render();

  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('resize', resize);
    window.removeEventListener('nexus-bullet', onBullet);
    canvas.remove();
  };
}

function Scene({ players, cars, police, localPlayerId, yaw }: SceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const liveProps = useRef<SceneProps>({ players, cars, police, localPlayerId, yaw });
  liveProps.current = { players, cars, police, localPlayerId, yaw };

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#a7b8ac');
    scene.fog = new THREE.Fog('#a7b8ac', 90, 300);
    const camera = new THREE.PerspectiveCamera(48, root.clientWidth / root.clientHeight, .1, 500);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      return startCanvasFallback(root, liveProps);
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    renderer.setSize(root.clientWidth, root.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.14;
    root.appendChild(renderer.domElement);

    const hemi = new THREE.HemisphereLight('#f1ecd7', '#536b61', 2.0);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight('#ffe5b0', 3.0);
    sun.position.set(-34, 55, 28);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -70; sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70; sun.shadow.camera.bottom = -70;
    scene.add(sun);

    const groundMat = new THREE.MeshStandardMaterial({ color: '#778c72', roughness: 1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -.08;
    ground.receiveShadow = true;
    scene.add(ground);

    const roads = new THREE.Group();
    for (let n = -5; n <= 5; n++) {
      const pos = n * 40;
      const roadWidth = n === 0 ? 14 : 8;
      const horizontal = new THREE.Mesh(new THREE.BoxGeometry(400, .06, roadWidth), new THREE.MeshStandardMaterial({ color: n === 0 ? '#5e6762' : '#6a726b', roughness: .96 }));
      horizontal.position.set(0, .01, pos);
      horizontal.receiveShadow = true;
      roads.add(horizontal);
      const vertical = new THREE.Mesh(new THREE.BoxGeometry(roadWidth, .06, 400), horizontal.material);
      vertical.position.set(pos, .012, 0);
      vertical.receiveShadow = true;
      roads.add(vertical);
      if (n !== 0) {
        const dashes = new THREE.Mesh(new THREE.BoxGeometry(400, .07, .12), new THREE.MeshBasicMaterial({ color: '#d5c99c' }));
        dashes.position.set(0, .055, pos);
        roads.add(dashes);
        const dashes2 = new THREE.Mesh(new THREE.BoxGeometry(.12, .07, 400), dashes.material);
        dashes2.position.set(pos, .057, 0);
        roads.add(dashes2);
      }
    }
    scene.add(roads);

    const city = new THREE.Group();
    const buildingColors = ['#c58b63', '#d5b17b', '#9aab97', '#b9c0a4', '#d0a578', '#8e9e98', '#c3a48b'];
    const roofColors = ['#596c67', '#8b6757', '#687c6d', '#927e63'];
    const seeded = (x: number, z: number, k: number) => {
      const v = Math.sin(x * 127.1 + z * 311.7 + k * 74.7) * 43758.5453;
      return v - Math.floor(v);
    };
    for (let gx = -5; gx < 5; gx++) {
      for (let gz = -5; gz < 5; gz++) {
        const x0 = gx * 40 + 20;
        const z0 = gz * 40 + 20;
        const width = 15 + seeded(gx, gz, 1) * 10;
        const depth = 15 + seeded(gx, gz, 2) * 10;
        const height = 7 + seeded(gx, gz, 3) * 35;
        const body = new THREE.Mesh(
          new THREE.BoxGeometry(width, height, depth),
          new THREE.MeshStandardMaterial({ color: buildingColors[Math.floor(seeded(gx, gz, 4) * buildingColors.length)], roughness: .87, flatShading: true }),
        );
        body.position.set(x0, height / 2, z0);
        body.castShadow = true;
        body.receiveShadow = true;
        city.add(body);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(width + .25, .28, depth + .25), new THREE.MeshStandardMaterial({ color: roofColors[Math.floor(seeded(gx, gz, 5) * roofColors.length)], flatShading: true }));
        roof.position.set(x0, height + .12, z0);
        roof.castShadow = true;
        city.add(roof);
        if (height > 8) {
          const awning = new THREE.Mesh(new THREE.BoxGeometry(width * .76, .3, .24), new THREE.MeshStandardMaterial({ color: '#e4bd67', flatShading: true }));
          awning.position.set(x0, 2.15, z0 - depth / 2 - .13);
          city.add(awning);
        }
      }
    }
    scene.add(city);

    const streetProps = new THREE.Group();
    for (let gx = -5; gx < 5; gx++) {
      for (let gz = -5; gz < 5; gz++) {
        const x = gx * 40 + 13;
        const z = gz * 40 + 14;
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(.12, .19, 1.3, 5), new THREE.MeshStandardMaterial({ color: '#6c5943', flatShading: true }));
        trunk.position.set(x, .65, z);
        trunk.castShadow = true;
        const crown = new THREE.Mesh(new THREE.IcosahedronGeometry(.9 + seeded(gx, gz, 8) * .35, 0), new THREE.MeshStandardMaterial({ color: seeded(gx, gz, 7) > .5 ? '#668a6e' : '#789578', flatShading: true }));
        crown.position.set(x, 1.8, z);
        crown.castShadow = true;
        streetProps.add(trunk, crown);
      }
    }
    scene.add(streetProps);

    const actors = new Map<string, { body: THREE.Group; label: THREE.Sprite; target: THREE.Vector3; targetRotation: number; local: boolean }>();
    const carObjects = new Map<string, { body: THREE.Group; target: THREE.Vector3; targetRotation: number }>();
    const bullets = new Map<string, { mesh: THREE.Mesh; velocity: THREE.Vector3; born: number }>();
    const policeObjects: THREE.Group[] = [];
    const playerGeom = new THREE.CapsuleGeometry(.36, .7, 3, 6);
    const playerFallback = new THREE.MeshStandardMaterial({ color: '#55b9a3', roughness: .8, flatShading: true });
    const carGeo = new THREE.BoxGeometry(1.55, .68, 2.6);
    const windowGeo = new THREE.BoxGeometry(1.22, .5, 1.16);
    const tireGeo = new THREE.CylinderGeometry(.23, .23, .18, 8);
    const tireMat = new THREE.MeshStandardMaterial({ color: '#20282a', roughness: 1 });

    const createCar = (car: Car) => {
      const group = new THREE.Group();
      const paint = new THREE.MeshStandardMaterial({ color: colorOf(car.color, '#d5aa56'), roughness: .38, metalness: .18, flatShading: true });
      const base = new THREE.Mesh(carGeo, paint);
      base.position.y = .62; base.castShadow = true; base.receiveShadow = true; group.add(base);
      const cabin = new THREE.Mesh(windowGeo, new THREE.MeshStandardMaterial({ color: '#43585b', roughness: .28, metalness: .2, flatShading: true }));
      cabin.position.set(0, 1.12, -.12); cabin.castShadow = true; group.add(cabin);
      for (const sx of [-.69, .69]) for (const sz of [-.82, .82]) {
        const tire = new THREE.Mesh(tireGeo, tireMat);
        tire.rotation.z = Math.PI / 2;
        tire.position.set(sx, .28, sz);
        group.add(tire);
      }
      const lampMat = new THREE.MeshBasicMaterial({ color: '#f3df9d' });
      for (const sx of [-.52, .52]) {
        const lamp = new THREE.Mesh(new THREE.BoxGeometry(.24, .16, .06), lampMat);
        lamp.position.set(sx, .63, 1.32);
        group.add(lamp);
      }
      scene.add(group);
      return { body: group, target: new THREE.Vector3(car.x, 0, car.z), targetRotation: car.rotation };
    };

    const createPlayer = (player: Player, local: boolean) => {
      const group = new THREE.Group();
      const material = new THREE.MeshStandardMaterial({ color: colorOf(player.color, '#52b9a7'), roughness: .72, flatShading: true });
      const body = new THREE.Mesh(playerGeom, material);
      body.position.y = .72; body.castShadow = true; body.receiveShadow = true;
      group.add(body);
      const head = new THREE.Mesh(new THREE.IcosahedronGeometry(.23, 1), new THREE.MeshStandardMaterial({ color: '#e9c7a0', flatShading: true }));
      head.position.y = 1.37; head.castShadow = true; group.add(head);
      const marker = new THREE.Mesh(new THREE.BoxGeometry(.46, .12, .54), new THREE.MeshStandardMaterial({ color: '#25383a', flatShading: true }));
      marker.position.set(0, .43, -.02); group.add(marker);
      const label = makeLabel(player.name, player.color);
      label.position.y = 2.15;
      group.add(label);
      scene.add(group);
      return { body: group, label, target: new THREE.Vector3(player.x, 0, player.z), targetRotation: player.rotation, local };
    };

    let active = true;
    let frame = 0;
    const clock = new THREE.Clock();
    const resize = () => {
      const w = root.clientWidth, h = root.clientHeight;
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', resize);

    const animate = () => {
      if (!active) return;
      frame = requestAnimationFrame(animate);
      const now = clock.getElapsedTime();
      const current = liveProps.current;
      const seen = new Set<string>();
      current.players.forEach((p) => {
        if (p.carId) return;
        seen.add(p.id);
        let actor = actors.get(p.id);
        if (!actor) {
          actor = createPlayer(p, p.id === current.localPlayerId);
          actors.set(p.id, actor);
        }
        actor.target.set(p.x, 0, p.z);
        actor.targetRotation = p.rotation;
        actor.body.position.lerp(actor.target, actor.local ? .4 : .16);
        actor.body.rotation.y = THREE.MathUtils.lerp(actor.body.rotation.y, actor.targetRotation, actor.local ? .28 : .13);
        actor.label.material.opacity = 1;
      });
      for (const [id, actor] of actors) {
        if (!seen.has(id)) {
          scene.remove(actor.body);
          actor.body.traverse((obj) => {
          if (obj instanceof THREE.Mesh || obj instanceof THREE.Sprite) {
              if (obj instanceof THREE.Mesh) obj.geometry.dispose();
              const mat = obj.material;
              if (Array.isArray(mat)) mat.forEach((m) => m.dispose()); else mat.dispose();
            }
          });
          actors.delete(id);
        }
      }
      const seenCars = new Set<string>();
      current.cars.forEach((c) => {
        seenCars.add(c.id);
        let car = carObjects.get(c.id);
        if (!car) { car = createCar(c); carObjects.set(c.id, car); }
        car.target.set(c.x, 0, c.z);
        car.targetRotation = c.rotation;
        car.body.position.lerp(car.target, .2);
        car.body.rotation.y = THREE.MathUtils.lerp(car.body.rotation.y, c.rotation, .18);
      });
      for (const [id, car] of carObjects) if (!seenCars.has(id)) { scene.remove(car.body); carObjects.delete(id); }

      while (policeObjects.length > current.police.length) {
        const p = policeObjects.pop();
        if (p) scene.remove(p);
      }
      current.police.forEach((p, index) => {
        if (!policeObjects[index]) {
          const unit = new THREE.Group();
          const body = new THREE.Mesh(carGeo, new THREE.MeshStandardMaterial({ color: '#d9d7c7', flatShading: true }));
          body.position.y = .56; body.castShadow = true; unit.add(body);
          const stripe = new THREE.Mesh(new THREE.BoxGeometry(1.58, .2, .65), new THREE.MeshStandardMaterial({ color: '#4883a0', flatShading: true }));
          stripe.position.y = .88; unit.add(stripe);
          const light = new THREE.Mesh(new THREE.BoxGeometry(.62, .17, .18), new THREE.MeshBasicMaterial({ color: '#df705d' }));
          light.position.set(0, 1.1, -.1); unit.add(light);
          scene.add(unit);
          policeObjects[index] = unit;
        }
        policeObjects[index].position.set(p.x, 0, p.z);
        policeObjects[index].rotation.y = p.rotation;
      });

      const local = current.players.find((p) => p.id === current.localPlayerId);
      const focus = local ? new THREE.Vector3(local.x, 0, local.z) : new THREE.Vector3(0, 0, 0);
      const activeCar = local?.carId ? current.cars.find((c) => c.id === local.carId) : undefined;
      const lookYaw = current.yaw;
      const distance = activeCar ? 10.5 : 8.3;
      const height = activeCar ? 5.8 : 5.3;
      const cameraTarget = new THREE.Vector3(
        focus.x - Math.sin(lookYaw) * distance,
        height,
        focus.z - Math.cos(lookYaw) * distance,
      );
      camera.position.lerp(cameraTarget, .075);
      camera.lookAt(focus.x, activeCar ? 1.1 : 1.0, focus.z);

      for (const [id, bullet] of bullets) {
        bullet.mesh.position.addScaledVector(bullet.velocity, clock.getDelta() * 0 + .28);
        if (now - bullet.born > 2.8) { scene.remove(bullet.mesh); bullets.delete(id); }
      }
      renderer.render(scene, camera);
    };
    animate();

    const onBullet = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; color: string; origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }>).detail;
      if (!detail || bullets.has(detail.id)) return;
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(.09, 6, 6), new THREE.MeshBasicMaterial({ color: colorOf(detail.color, '#f2bd55') }));
      mesh.position.set(detail.origin.x, detail.origin.y, detail.origin.z);
      scene.add(mesh);
      bullets.set(detail.id, { mesh, velocity: new THREE.Vector3(detail.direction.x, detail.direction.y, detail.direction.z).normalize().multiplyScalar(.8), born: clock.getElapsedTime() });
    };
    window.addEventListener('nexus-bullet', onBullet);

    return () => {
      active = false;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      window.removeEventListener('nexus-bullet', onBullet);
      renderer.dispose();
      root.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={host} className="game-world" aria-label="Nexus City 3D multiplayer world" />;
}

function clampPercent(n: number) { return Math.max(0, Math.min(100, n)); }

export default function Game() {
  const gameInfoQuery = useGetGameInfo();
  const gameInfo = gameInfoQuery.data;
  const socketRef = useRef<Socket | null>(null);
  const keyRef = useRef({ ...keyInput });
  const yawRef = useRef(0);
  const lookRef = useRef(0);
  const mouseRef = useRef({ down: false, x: 0 });
  const localRef = useRef<Player | null>(null);
  const playersRef = useRef<Player[]>([]);
  const carsRef = useRef<Car[]>([]);
  const chatEnd = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY_SNAPSHOT);
  const [localId, setLocalId] = useState<string | null>(null);
  const [local, setLocal] = useState<Player | null>(null);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatText, setChatText] = useState('');
  const [connected, setConnected] = useState(false);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [liveOnlinePlayers, setLiveOnlinePlayers] = useState<number | null>(null);
  const [serverMessage, setServerMessage] = useState('');
  const [yaw, setYaw] = useState(0);
  const [alert, setAlert] = useState('');
  const [mobileChatVisible, setMobileChatVisible] = useState(true);
  const [isTouch] = useState(() => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches);

  const applySnapshot = useCallback((next: Snapshot, onlinePlayers?: number) => {
    playersRef.current = next.players || [];
    carsRef.current = next.cars || [];
    setSnapshot({ players: next.players || [], cars: next.cars || [], police: next.police || [] });
    const mine = (next.players || []).find((p) => p.id === localRef.current?.id);
    if (mine) {
      localRef.current = mine;
      setLocal(mine);
    }
    setHasSnapshot(true);
    if (typeof onlinePlayers === 'number') {
      setLiveOnlinePlayers(onlinePlayers);
    } else {
      setLiveOnlinePlayers(next.players?.length ?? 0);
    }
  }, []);

  useEffect(() => {
    const socket = io({ path: '/api/socket.io', transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: Infinity });
    socketRef.current = socket;
    socket.on('connect', () => { setConnected(true); setHasSnapshot(false); setServerMessage(''); });
    socket.on('disconnect', () => { setConnected(false); });
    socket.on('connect_error', () => { setConnected(false); });
    socket.on('joined', (data: { playerId: string; player: Player; players: Player[]; cars: Car[]; police: Police[] }) => {
      localRef.current = data.player;
      setLocal(data.player);
      setLocalId(data.playerId);
      yawRef.current = data.player.rotation || 0;
      setYaw(yawRef.current);
      applySnapshot({ players: data.players, cars: data.cars, police: data.police });
      setServerMessage('');
    });
    socket.on('playerUpdate', (data: { players: Player[]; cars: Car[]; police: Police[]; onlinePlayers: number }) => {
      applySnapshot(data, data.onlinePlayers);
    });
    socket.on('chatMessage', (line: ChatLine) => {
      setChat((items) => [...items.slice(-39), line]);
      setMobileChatVisible(true);
    });
    socket.on('bulletFired', (bullet: { id: string; playerId: string; color: string; origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } }) => {
      window.dispatchEvent(new CustomEvent('nexus-bullet', { detail: bullet }));
    });
    socket.on('serverFull', (data: { message: string }) => setServerMessage(data.message || 'The city is full. Try again shortly.'));
    return () => { socket.removeAllListeners(); socket.disconnect(); socketRef.current = null; };
  }, [applySnapshot]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (lookRef.current) {
        yawRef.current += lookRef.current * LOOK_SPEED;
        setYaw(yawRef.current);
      }
      if (!socketRef.current?.connected) return;
      const k = keyRef.current;
      socketRef.current.emit('playerInput', {
        forward: k.forward, backward: k.backward, left: k.left, right: k.right,
        sprint: k.sprint, brake: k.brake, rotation: yawRef.current,
      } satisfies GameInput);
    }, 50);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';
      const code = event.code;
      if (code === 'Space' && !typing) event.preventDefault();
      if (!typing && (code === 'KeyW' || code === 'ArrowUp')) keyRef.current.forward = true;
      if (!typing && (code === 'KeyS' || code === 'ArrowDown')) keyRef.current.backward = true;
      if (!typing && (code === 'KeyA' || code === 'ArrowLeft')) keyRef.current.left = true;
      if (!typing && (code === 'KeyD' || code === 'ArrowRight')) keyRef.current.right = true;
      if (!typing && code === 'ShiftLeft') keyRef.current.sprint = true;
      if (!typing && code === 'Space') keyRef.current.brake = true;
      if (event.repeat || typing) return;
      if (code === 'KeyT') {
        event.preventDefault();
        setChatOpen(true);
        window.setTimeout(() => chatInputRef.current?.focus(), 20);
      }
      if (code === 'Escape') {
        setChatOpen(false);
        chatInputRef.current?.blur();
      }
      if (code === 'KeyE') {
        if (!localRef.current || !socketRef.current?.connected) return;
        const me = localRef.current;
        if (me.carId) {
          socketRef.current.emit('exitCar');
          setAlert('Exiting vehicle');
        } else {
          const available = carsRef.current
            .filter((car) => !car.driverId)
            .map((car) => ({ car, dist: Math.hypot(car.x - me.x, car.z - me.z) }))
            .sort((a, b) => a.dist - b.dist)[0];
          if (available && available.dist < 5.5) {
            socketRef.current.emit('enterCar', { carId: available.car.id });
            setAlert(`Claiming ${available.car.id}`);
          } else {
            setAlert('Move closer to an unclaimed car');
          }
          window.setTimeout(() => setAlert(''), 1700);
        }
      }
    };
    const up = (event: KeyboardEvent) => {
      const code = event.code;
      if (code === 'KeyW' || code === 'ArrowUp') keyRef.current.forward = false;
      if (code === 'KeyS' || code === 'ArrowDown') keyRef.current.backward = false;
      if (code === 'KeyA' || code === 'ArrowLeft') keyRef.current.left = false;
      if (code === 'KeyD' || code === 'ArrowRight') keyRef.current.right = false;
      if (code === 'ShiftLeft') keyRef.current.sprint = false;
      if (code === 'Space') keyRef.current.brake = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  const nearestCar = useMemo(() => {
    if (!local || local.carId) return null;
    return snapshot.cars
      .filter((car) => !car.driverId)
      .map((car) => ({ car, dist: Math.hypot(car.x - local.x, car.z - local.z) }))
      .sort((a, b) => a.dist - b.dist)[0] || null;
  }, [local, snapshot.cars]);

  const sendChat = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text || !socketRef.current?.connected) return;
    socketRef.current.emit('chatMessage', text);
    setChatText('');
    setChatOpen(false);
  };

  const shoot = useCallback(() => {
    const me = localRef.current;
    if (!me || me.carId || !socketRef.current?.connected) return;
    const rotation = yawRef.current;
    socketRef.current.emit('shoot', {
      origin: { x: me.x, y: 1.1, z: me.z },
      direction: { x: Math.sin(rotation), y: -.015, z: Math.cos(rotation) },
    });
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLCanvasElement)) return;
    if (event.button === 0) {
      mouseRef.current = { down: true, x: event.clientX };
      shoot();
    }
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!mouseRef.current.down || !(event.target instanceof HTMLCanvasElement)) return;
    const delta = event.clientX - mouseRef.current.x;
    mouseRef.current.x = event.clientX;
    yawRef.current += delta * .006;
    setYaw(yawRef.current);
  };
  const onPointerUp = () => { mouseRef.current.down = false; };

  const onMoveStick = useCallback((x: number, y: number) => {
    const k = keyRef.current;
    k.left = x < -STICK_DEADZONE;
    k.right = x > STICK_DEADZONE;
    k.forward = y < -STICK_DEADZONE;
    k.backward = y > STICK_DEADZONE;
  }, []);

  const onLookStick = useCallback((x: number) => {
    lookRef.current = Math.abs(x) < STICK_DEADZONE ? 0 : x;
  }, []);

  const mapPoint = (value: number) => clampPercent(((value + WORLD_EXTENT) / (WORLD_EXTENT * 2)) * 100);
  const status = connected ? (hasSnapshot ? 'CITY LIVE' : 'SYNCING WORLD') : 'RECONNECTING';
  const isBooting = gameInfoQuery.isLoading && !gameInfo && !serverMessage;
  const onlineCount = liveOnlinePlayers ?? (hasSnapshot ? snapshot.players.length : gameInfo?.onlinePlayers ?? 0);
  const localCar = local?.carId ? snapshot.cars.find((car) => car.id === local.carId) : undefined;
    const speed = Math.round(Math.abs(localCar?.velocity ?? local?.speed ?? 0));

  return (
    <main className="game-shell" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <Scene {...snapshot} localPlayerId={localId} yaw={yaw} />
      <div className="grain" />
      <div className="crosshair"><span /></div>
      <div className="hud">
        <header className="topbar">
          <div className="brand-lockup">
            <div className="brand-mark"><span>N</span></div>
            <div><div className="brand-name">NEXUS CITY</div><div className="brand-sub">ONLINE // SESSION 01</div></div>
          </div>
          <div>
            <div className="server-pill" data-testid="status-server">
              <span className={`live-dot ${connected && hasSnapshot ? 'online' : connected ? '' : 'offline'}`} />
              <span>{status}</span>
              <Wifi size={13} strokeWidth={1.7} />
            </div>
            <div className="top-meta">
              <span>{gameInfo?.name || 'EAST HARBOR'}</span>
              <span>{gameInfo?.tickRate ? `${gameInfo.tickRate} TICK` : 'CITY SHARD 01'}</span>
            </div>
          </div>
        </header>

        <section className="panel status-panel" aria-label="Player status">
          <div className="player-name" data-testid="text-player-name">{local?.name || 'ROOKIE'}</div>
          <div className="player-tag">CITIZEN // {localId ? localId.slice(0, 6).toUpperCase() : 'CONNECTING'}</div>
          <div className="status-divider" />
          <div className="stats-row">
            <div className="stat-item"><span className="stat-label">Cash</span><span className="stat-number"><span style={{ fontSize: 11 }}>$</span>{(local?.money ?? 0).toLocaleString()}</span></div>
            <div className="stat-item"><span className="stat-label">Elims</span><span className="stat-number light"><Trophy size={13} style={{ display: 'inline', marginRight: 4 }} />{local?.kills ?? 0}</span></div>
            <div className="stat-item"><span className="stat-label">Health</span><span className="stat-number light"><Heart size={13} style={{ display: 'inline', marginRight: 4, color: '#85c8a4' }} />{local?.health ?? 100}</span></div>
          </div>
          <div className="health-wrap">
            <div className="health-label"><span>Condition</span><span>{local?.health ?? 100}%</span></div>
            <div className="health-track"><div className="health-fill" style={{ width: `${clampPercent(local?.health ?? 100)}%` }} /></div>
          </div>
          <div className="wanted-row"><span className="wanted-label"><Shield size={12} style={{ display: 'inline', marginRight: 5 }} />Heat level</span><span className="wanted-stars">{[1, 2, 3, 4, 5].map((level) => <i key={level} className={`wanted-star ${level <= (local?.wanted ?? 0) ? 'on' : ''}`} />)}</span></div>
        </section>

        <aside className="side-stack">
          <section className="panel minimap-panel">
            <div className="panel-heading"><span>District radar</span><MapPin size={13} /></div>
            <div className="map-frame" data-testid="map-radar">
              <div className="map-road horizontal" /><div className="map-road vertical" />
              <div className="map-block" style={{ left: '10%', top: '18%', width: '22%', height: '22%' }} />
              <div className="map-block" style={{ left: '60%', top: '12%', width: '28%', height: '26%' }} />
              <div className="map-block" style={{ left: '12%', top: '65%', width: '26%', height: '21%' }} />
              <div className="map-block" style={{ left: '62%', top: '64%', width: '25%', height: '23%' }} />
              <div className="map-label">EAST HARBOR</div>
              {snapshot.players.filter((p) => p.id !== localId).map((p) => <span key={p.id} className={`map-dot ${p.wanted > 0 ? 'wanted' : ''}`} style={{ left: `${mapPoint(p.x)}%`, top: `${mapPoint(p.z)}%` }} title={p.name} />)}
              {snapshot.cars.map((c) => <span key={`car-${c.id}`} className="map-dot" style={{ width: 4, height: 4, background: c.driverId ? '#a6bba0' : '#d5aa56', left: `${mapPoint(c.x)}%`, top: `${mapPoint(c.z)}%` }} title={c.id} />)}
              {local && <span className="map-dot self" style={{ left: `${mapPoint(local.x)}%`, top: `${mapPoint(local.z)}%` }} />}
            </div>
            <div className="map-footer"><span>YOU</span><span>{snapshot.players.length} SIGNALS</span></div>
          </section>
          <section className="panel nearby-panel">
            <div className="panel-heading"><span>In the city</span><Activity size={13} /></div>
            <div className="nearby-value" data-testid="text-online-count">{String(onlineCount).padStart(2, '0')}<small>/ {gameInfo?.maxPlayers ?? '—'} ONLINE</small></div>
            <div className="nearby-detail">{gameInfo?.availableCars ?? Math.max(0, 5 - snapshot.cars.filter((c) => c.driverId).length)} CLAIMABLE RIDES</div>
          </section>
          <div className="panel mission-chip"><i /><span>OPEN CITY · NO QUEUE</span><CarFront size={14} /></div>
        </aside>

        <section className="chat-panel" style={{ display: mobileChatVisible ? 'flex' : 'none' }} aria-label="City chat">
          <div className="chat-head"><span><MessageCircle size={12} style={{ display: 'inline', marginRight: 6 }} />City frequency</span><span>{chat.length.toString().padStart(2, '0')}</span></div>
          <div className="chat-feed" data-testid="list-chat">
            {chat.length === 0 ? <div className="chat-placeholder">No transmissions yet. Say something.</div> : chat.map((line) => <div className="chat-line" key={line.id}><span className="chat-time">{typeof line.at === 'number' ? new Date(line.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</span><span className="chat-name" style={{ color: line.color }}>{line.name}</span>{line.text}</div>)}
            <div ref={chatEnd} />
          </div>
          {chatOpen && <form className="chat-form" onSubmit={sendChat}>
            <input ref={chatInputRef} className="chat-input" value={chatText} maxLength={180} onChange={(event) => setChatText(event.target.value)} placeholder="Transmit to the city..." data-testid="input-chat" />
            <button type="submit" className="send-button" aria-label="Send chat" data-testid="button-send-chat"><Send size={14} /></button>
          </form>}
        </section>
        {!chatOpen && <button className="chat-open" onClick={() => { setChatOpen(true); window.setTimeout(() => chatInputRef.current?.focus(), 20); }} data-testid="button-open-chat">T · CHAT</button>}

        <div className="controls-bar" aria-label="Controls">
          <div className="control-hint"><span className="keycap">W</span><span className="keycap">A</span><span className="keycap">S</span><span className="keycap">D</span><span>MOVE</span></div>
          <div className="control-hint"><span className="keycap">SHIFT</span><span>SPRINT</span></div>
          <div className="control-hint"><span className="keycap">SPACE</span><span>BRAKE</span></div>
          <div className="control-hint"><span className="keycap">E</span><span>{local?.carId ? 'EXIT RIDE' : 'CLAIM RIDE'}</span></div>
          <div className="control-hint"><span className="keycap">T</span><span>CHAT</span></div>
          <div className="control-hint"><span className="keycap">LMB</span><span>FIRE</span></div>
        </div>

        <div className="right-bottom">
          <div className="location-label">{localCar ? localCar.id : 'EAST HARBOR / BLOCK 04'}</div>
          <div className="location-sub">{localCar ? 'VEHICLE CONTROL' : 'DRAG TO LOOK · ROAM FREE'}</div>
          {localCar && <div className="speedometer"><strong>{speed}</strong><span>km/h</span></div>}
          {!local?.carId && nearestCar && nearestCar.dist < 10 && <div className="enter-hint">{nearestCar.dist < 5.5 ? 'E · ENTER' : 'APPROACH VEHICLE'} — {nearestCar.car.id}</div>}
        </div>
        {alert && <div className="alert-banner">{alert}</div>}
        {isTouch && <TouchJoystick side="left" label="Move" onChange={onMoveStick} />}
        {isTouch && <TouchJoystick side="right" label="Look" onChange={(x) => onLookStick(x)} />}
      </div>
      {serverMessage && <div className="boot-screen"><div className="boot-card"><div className="boot-eyebrow">NEXUS CITY // NETWORK NOTICE</div><div className="boot-title">CITY AT CAPACITY</div><div className="boot-copy">{serverMessage}</div><button className="reconnect-button" onClick={() => { setServerMessage(''); socketRef.current?.connect(); }} data-testid="button-reconnect">RETRY CONNECTION</button></div></div>}
      {isBooting && <div className="boot-screen"><div className="boot-card"><div className="boot-eyebrow">NEXUS CITY ONLINE</div><div className="boot-title">FINDING<br />YOUR PLACE.</div><div className="boot-copy">Checking the city shard and preparing your connection.</div><div className="boot-progress"><span /></div></div></div>}
    </main>
  );
}
