/**
 * client/main.client.ts
 *
 * Squad Runner Shooting Game – Client
 *
 * Handles:
 *  - Squad visual rendering (blue soldiers in grid formation)
 *  - Enemy / boss visual rendering with HP bars
 *  - Obstacle rendering with HP counters
 *  - A/D + touch drag steering to pick gate sides
 *  - Gate proximity detection → fires GateTrigger to server
 *  - Auto-shoot rays toward nearest enemy + projectile FX
 *  - HUD: wave, score, squad count, multiplier, boss HP bar
 *  - Hero ultimate overlay notifications
 *  - "Best side" hint arrow over gate pairs
 */

import { Players, UserInputService, RunService, Workspace, TweenService } from "@rbxts/services";
import {
	PATH_WIDTH,
	FLOOR_Y,
	GameState,
	HEROES,
	STARTING_SQUAD,
	betterSide,
	type GameStateData,
	type EnemySpawnData,
	type EnemyHealthData,
	type ObstacleData,
} from "../shared/types";
import {
	getGameStateRemote,
	getEnemySpawnedRemote,
	getEnemyHealthRemote,
	getEnemyReachedEndRemote,
	getObstacleSpawnRemote,
	getObstacleHealthRemote,
	getHeroUltimateRemote,
	getShootRemote,
	getGateTriggerRemote,
	getRequestStateFunction,
} from "../shared/remotes";

// ---------------------------------------------------------------------------
// World / squad constants
// ---------------------------------------------------------------------------
const MARCH_SPEED   = 9;    // forward studs/s
const STEER_SPEED   = 14;   // lateral studs/s
const SQUAD_FORM_R  = 3.5;  // formation spread radius
const MAX_SOLDIERS  = 35;   // cap on rendered parts
const PLAYER_Z      = 0;
const FAR_Z         = -75;
const SHOOT_RATE    = 0.12; // seconds between shots

// ---------------------------------------------------------------------------
// Synced game state — must sit before any closure (e.g. autoShoot) reads it, otherwise
// roblox-ts emits a separate uninitialized local and squad count can desync from visuals.
// ---------------------------------------------------------------------------
let curState: GameState = GameState.Lobby;
let currentSquadSize = STARTING_SQUAD;

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------
const localPlayer = Players.LocalPlayer;
const playerGui   = localPlayer.WaitForChild("PlayerGui") as PlayerGui;
const screenGui   = new Instance("ScreenGui");
screenGui.Name = "GameHUD"; screenGui.ResetOnSpawn = false;
screenGui.Parent = playerGui;

// Top bar
const topBar = new Instance("Frame");
topBar.Size = new UDim2(1, 0, 0, 64);
topBar.BackgroundColor3 = new Color3(0, 0, 0);
topBar.BackgroundTransparency = 0.35;
topBar.Parent = screenGui;

function hudLabel(x: number, w: number, text: string): TextLabel {
	const l = new Instance("TextLabel");
	l.Size = new UDim2(0, w, 1, 0);
	l.Position = new UDim2(0, x, 0, 0);
	l.BackgroundTransparency = 1;
	l.Font = Enum.Font.GothamBold;
	l.TextColor3 = new Color3(1, 1, 1);
	l.TextScaled = true;
	l.Text = text;
	l.Parent = topBar;
	return l;
}
const lblWave  = hudLabel(8,   160, "Wave 1");
const lblScore = hudLabel(176, 200, "0");
const lblSquad = hudLabel(384, 200, "Squad 15");
const lblMult  = hudLabel(592, 120, "x1");

// Boss HP bar (hidden until boss fight)
const bossBarBg = new Instance("Frame");
bossBarBg.Size = new UDim2(0.5, 0, 0, 24);
bossBarBg.Position = new UDim2(0.25, 0, 0, 68);
bossBarBg.BackgroundColor3 = new Color3(0.15, 0.15, 0.15);
bossBarBg.Visible = false;
bossBarBg.Parent = screenGui;

const bossBarFill = new Instance("Frame");
bossBarFill.Size = new UDim2(1, 0, 1, 0);
bossBarFill.BackgroundColor3 = new Color3(1, 0.1, 0.1);
bossBarFill.BorderSizePixel = 0;
bossBarFill.Parent = bossBarBg;

const bossBarLbl = new Instance("TextLabel");
bossBarLbl.Size = new UDim2(1, 0, 1, 0);
bossBarLbl.BackgroundTransparency = 1;
bossBarLbl.Font = Enum.Font.GothamBold;
bossBarLbl.TextColor3 = new Color3(1, 1, 1);
bossBarLbl.TextScaled = true;
bossBarLbl.Text = "BOSS";
bossBarLbl.Parent = bossBarBg;

// Overlay (wave clear / game over)
const overlay = new Instance("Frame");
overlay.Size = new UDim2(1, 0, 1, 0);
overlay.BackgroundColor3 = new Color3(0, 0, 0);
overlay.BackgroundTransparency = 0.5;
overlay.Visible = false;
overlay.Parent = screenGui;

const overlayLbl = new Instance("TextLabel");
overlayLbl.Size = new UDim2(0.7, 0, 0.25, 0);
overlayLbl.Position = new UDim2(0.15, 0, 0.375, 0);
overlayLbl.BackgroundTransparency = 1;
overlayLbl.Font = Enum.Font.GothamBold;
overlayLbl.TextColor3 = new Color3(1, 1, 0);
overlayLbl.TextScaled = true;
overlayLbl.Text = "";
overlayLbl.Parent = overlay;

// Ultimate notification
const ultNotif = new Instance("TextLabel");
ultNotif.Size = new UDim2(0.6, 0, 0.07, 0);
ultNotif.Position = new UDim2(0.2, 0, 0.15, 0);
ultNotif.BackgroundTransparency = 1;
ultNotif.Font = Enum.Font.GothamBold;
ultNotif.TextColor3 = new Color3(1, 0.8, 0);
ultNotif.TextScaled = true;
ultNotif.Text = "";
ultNotif.Visible = false;
ultNotif.Parent = screenGui;

// ---------------------------------------------------------------------------
// Squad visuals
// ---------------------------------------------------------------------------
interface SoldierVis { body: Part; head: Part }
const squadFolder = new Instance("Folder");
squadFolder.Name = "Squad"; squadFolder.Parent = Workspace;
const soldiers: SoldierVis[] = [];

function ensureSoldiers(count: number): void {
	while (soldiers.size() < count) {
		const body = new Instance("Part");
		body.Size = new Vector3(1.2, 1.9, 1.2);
		body.Anchored = true; body.CanCollide = false;
		body.Material = Enum.Material.SmoothPlastic;
		body.BrickColor = new BrickColor("White");
		body.Parent = squadFolder;

		const head = new Instance("Part");
		head.Size = new Vector3(1.3, 1.3, 1.3);
		head.Anchored = true; head.CanCollide = false;
		head.Shape = Enum.PartType.Ball;
		head.BrickColor = new BrickColor("Bright blue");
		head.Parent = squadFolder;

		soldiers.push({ body, head });
	}
}

function placeSoldiers(cx: number, cz: number, count: number): void {
	const safe = typeOf(count) === "number" && count >= 0 ? count : STARTING_SQUAD;
	const vis = math.min(safe, MAX_SOLDIERS);
	ensureSoldiers(vis);
	for (let i = 0; i < soldiers.size(); i++) {
		const show = i < vis;
		soldiers[i].body.Transparency = show ? 0 : 1;
		soldiers[i].head.Transparency = show ? 0 : 1;
		if (!show) continue;
		const cols = math.max(1, math.ceil(math.sqrt(vis)));
		const c = i % cols;
		const r = math.floor(i / cols);
		const x = cx + (c - cols / 2) * 1.45;
		const z = cz + (r - math.ceil(vis / cols) / 2) * 1.45;
		soldiers[i].body.Position = new Vector3(x, FLOOR_Y + 0.95, z);
		soldiers[i].head.Position = new Vector3(x, FLOOR_Y + 0.95 + 1.6, z);
	}
}

// ---------------------------------------------------------------------------
// Enemy visuals
// ---------------------------------------------------------------------------
interface EnemyVis { body: Part; head: Part; fill: Frame; maxHp: number; isBoss: boolean }
const enemyFolder = new Instance("Folder");
enemyFolder.Name = "Enemies"; enemyFolder.Parent = Workspace;
const enemyVisuals = new Map<number, EnemyVis>();

function spawnEnemyVisual(data: EnemySpawnData): void {
	const boss = data.isBoss;
	const body = new Instance("Part");
	body.Size = boss ? new Vector3(5, 8, 5) : new Vector3(2, 3, 2);
	body.Anchored = true; body.CanCollide = false;
	body.Material = Enum.Material.SmoothPlastic;
	body.BrickColor = boss ? new BrickColor("Pastel brown") : new BrickColor("Bright red");
	body.Position = data.position;
	body.Parent = enemyFolder;

	const head = new Instance("Part");
	head.Size = boss ? new Vector3(3.5, 3.5, 3.5) : new Vector3(1.8, 1.8, 1.8);
	head.Anchored = true; head.CanCollide = false;
	head.Shape = Enum.PartType.Ball;
	head.BrickColor = boss ? new BrickColor("Reddish brown") : new BrickColor("Reddish brown");
	head.Position = data.position.add(new Vector3(0, boss ? 6 : 2.5, 0));
	head.Parent = enemyFolder;

	// HP bar billboard
	const bb = new Instance("BillboardGui");
	bb.Size = new UDim2(0, boss ? 140 : 80, 0, boss ? 22 : 13);
	bb.StudsOffset = new Vector3(0, boss ? 7 : 3.5, 0);
	bb.Parent = body;

	const bg = new Instance("Frame");
	bg.Size = new UDim2(1, 0, 1, 0);
	bg.BackgroundColor3 = new Color3(0.2, 0.2, 0.2);
	bg.BorderSizePixel = 0;
	bg.Parent = bb;

	const fill = new Instance("Frame");
	fill.Size = new UDim2(1, 0, 1, 0);
	fill.BackgroundColor3 = boss ? new Color3(1, 0.3, 0) : new Color3(1, 0.1, 0.1);
	fill.BorderSizePixel = 0;
	fill.Parent = bg;

	enemyVisuals.set(data.id, { body, head, fill, maxHp: data.maxHp, isBoss: boss });
}

function updateEnemyVis(data: EnemyHealthData): void {
	const v = enemyVisuals.get(data.id);
	if (!v) return;
	v.fill.Size = new UDim2(data.hp / data.maxHp, 0, 1, 0);
	if (data.hp <= 0) {
		v.body.BrickColor = new BrickColor("Bright yellow");
		task.delay(0.2, () => { v.body.Destroy(); v.head.Destroy(); enemyVisuals.delete(data.id); });
	}
}

function removeEnemyVis(id: number): void {
	const v = enemyVisuals.get(id);
	if (!v) return;
	v.body.Destroy(); v.head.Destroy(); enemyVisuals.delete(id);
}

function syncEnemyPositions(): void {
	enemyVisuals.forEach((v, id) => {
		const sp = Workspace.FindFirstChild(`Enemy_${id}`) as Part | undefined;
		if (!sp) return;
		v.body.Position = sp.Position;
		v.head.Position = sp.Position.add(new Vector3(0, v.isBoss ? 6 : 2.5, 0));
	});
}

// ---------------------------------------------------------------------------
// Obstacle visuals
// ---------------------------------------------------------------------------
interface ObstacleVis { part: Part; fill: Frame; maxHp: number }
const obstVisuals = new Map<number, ObstacleVis>();

function spawnObstacleVis(data: ObstacleData): void {
	// The server already created the part; find it
	const serverPart = Workspace.FindFirstChild(`Obstacle_${data.id}`) as Part | undefined;
	if (!serverPart) return;

	const fill = new Instance("Frame");
	fill.Size = new UDim2(1, 0, 1, 0);
	fill.BackgroundColor3 = data.hasTroops ? new Color3(1, 0.9, 0) : new Color3(0.5, 0.3, 0.1);
	fill.BorderSizePixel = 0;

	const bg = new Instance("Frame");
	bg.Size = new UDim2(1, 0, 0.4, 0);
	bg.Position = new UDim2(0, 0, 0.6, 0);
	bg.BackgroundColor3 = new Color3(0.15, 0.15, 0.15);
	bg.BorderSizePixel = 0;
	bg.Parent = serverPart;
	fill.Parent = bg;

	obstVisuals.set(data.id, { part: serverPart, fill, maxHp: data.hp });
}

function updateObstacleVis(data: EnemyHealthData): void {
	const v = obstVisuals.get(data.id);
	if (!v) return;
	v.fill.Size = new UDim2(data.hp / data.maxHp, 0, 1, 0);
	if (data.hp <= 0) {
		// Flash white then let server part be destroyed
		v.part.BrickColor = new BrickColor("White");
		obstVisuals.delete(data.id);
	}
}

// ---------------------------------------------------------------------------
// Shooting
// ---------------------------------------------------------------------------
let shootTimer = 0;

function autoShoot(dt: number, cx: number, cz: number): void {
	shootTimer -= dt;
	if (shootTimer > 0) return;
	shootTimer = SHOOT_RATE;

	let nearestPos: Vector3 | undefined;
	let nearestDist = math.huge;
	enemyVisuals.forEach((v) => {
		const d = v.body.Position.sub(new Vector3(cx, FLOOR_Y + 1.5, cz)).Magnitude;
		if (d < nearestDist) { nearestDist = d; nearestPos = v.body.Position; }
	});
	if (!nearestPos) return;

	const origin = new Vector3(cx, FLOOR_Y + 1.5, cz - 1);
	const dir = nearestPos.sub(origin).Unit;

	// Spray visual projectiles proportional to squad size
	const rows = math.min(math.ceil(math.sqrt(math.min(currentSquadSize, MAX_SOLDIERS))), 6);
	for (let r = 0; r < rows; r++) {
		const xOff = (r - rows / 2) * 1.45;
		const proj = new Instance("Part");
		proj.Size = new Vector3(0.28, 0.28, 1.0);
		proj.Anchored = true; proj.CanCollide = false;
		proj.Material = Enum.Material.Neon;
		proj.BrickColor = new BrickColor("Bright yellow");
		proj.CFrame = new CFrame(new Vector3(origin.X + xOff, origin.Y, origin.Z), nearestPos);
		proj.Parent = Workspace;
		const t = TweenService.Create(proj, new TweenInfo(0.3, Enum.EasingStyle.Linear),
			{ Position: origin.add(dir.mul(60)) });
		t.Play();
		t.Completed.Connect(() => proj.Destroy());
	}

	getShootRemote().FireServer({ origin, direction: dir });
}

// ---------------------------------------------------------------------------
// Gate proximity
// ---------------------------------------------------------------------------
const triggeredGates = new Set<string>();

interface GatePanels {
	left?: Part;
	right?: Part;
}

function checkGates(cx: number, cz: number, squad: number): void {
	const map = Workspace.FindFirstChild("GameMap");
	if (!map) return;

	const gatesById = new Map<number, GatePanels>();
	map.GetChildren().forEach((child) => {
		if (!child.IsA("Part")) return;
		const name = child.Name;
		if (!name.match("^Gate_")[0]) return;
		const segs = name.split("_");
		if (segs.size() < 3) return;
		const gateId = tonumber(segs[1]);
		const side = segs[2];
		if (!gateId) return;
		let p = gatesById.get(gateId);
		if (!p) {
			p = {};
			gatesById.set(gateId, p);
		}
		const part = child as Part;
		if (side === "Left") p.left = part;
		else if (side === "Right") p.right = part;
	});

	gatesById.forEach((pair, gateId) => {
		const dedupeKey = `GatePair_${gateId}`;
		if (triggeredGates.has(dedupeKey)) return;
		const left = pair.left;
		const right = pair.right;
		if (!left || !right) return;

		const zDiff = left.Position.Z - cz;
		if (math.abs(zDiff) > 1.5) return;
		if (math.abs(cx) > PATH_WIDTH / 2 + 0.5) return;

		const distL = math.abs(cx - left.Position.X);
		const distR = math.abs(cx - right.Position.X);
		const pickLeft = distL < distR || (distL === distR && cx <= 0);
		const part = pickLeft ? left : right;
		const sideStr = pickLeft ? "Left" : "Right";
		if (math.abs(part.Position.X - cx) > PATH_WIDTH / 3) return;

		triggeredGates.add(dedupeKey);
		getGateTriggerRemote().FireServer(gateId, sideStr);

		const orig = part.BrickColor;
		part.BrickColor = new BrickColor("White");
		task.delay(0.25, () => {
			if (part && part.Parent) part.BrickColor = orig;
		});
	});
}

// ---------------------------------------------------------------------------
// State tracking
// ---------------------------------------------------------------------------
function onGameState(d: GameStateData): void {
	curState = d.state;
	const sz = d.squadSize;
	currentSquadSize = typeOf(sz) === "number" && sz >= 0 ? sz : STARTING_SQUAD;

	lblWave.Text  = `Wave ${d.wave}`;
	lblScore.Text = tostring(d.score);
	lblSquad.Text = `x${currentSquadSize}`;
	lblMult.Text  = `x${d.multiplier}`;

	if (d.bossMaxHp > 0) {
		bossBarBg.Visible = true;
		bossBarFill.Size  = new UDim2(d.bossHp / d.bossMaxHp, 0, 1, 0);
		bossBarLbl.Text   = `BOSS  ${d.bossHp} / ${d.bossMaxHp}`;
	} else {
		bossBarBg.Visible = false;
	}

	if (d.state === GameState.WaveComplete) {
		overlay.Visible   = true;
		overlayLbl.Text   = `Wave ${d.wave} Clear!\n+${100 * d.multiplier} pts`;
		task.delay(2.5, () => { overlay.Visible = false; });
	} else if (d.state === GameState.GameOver) {
		overlay.Visible = true;
		overlayLbl.Text = `GAME OVER\nScore: ${d.score}`;
	} else {
		overlay.Visible = false;
	}

	syncAvatarMovementLock();
}

// ---------------------------------------------------------------------------
// Avatar — Roblox still maps WASD/arrow to Humanoid movement, so players only
// saw their character move. Lock movement while the run is active so keys steer the squad.
// ---------------------------------------------------------------------------
const DEFAULT_WALKSPEED = 16;
const DEFAULT_JUMPPOWER = 50;

function applyAvatarMovementLock(character: Model | undefined, locked: boolean): void {
	if (!character) return;
	const hum = character.FindFirstChildOfClass("Humanoid");
	if (!hum) return;
	if (locked) {
		hum.WalkSpeed = 0;
		hum.JumpPower = 0;
		hum.AutoRotate = false;
	} else {
		hum.WalkSpeed = DEFAULT_WALKSPEED;
		hum.JumpPower = DEFAULT_JUMPPOWER;
		hum.AutoRotate = true;
	}
}

function syncAvatarMovementLock(): void {
	const locked = curState !== GameState.GameOver;
	applyAvatarMovementLock(localPlayer.Character ?? undefined, locked);
}

localPlayer.CharacterAdded.Connect((char) => {
	task.spawn(() => {
		char.WaitForChild("Humanoid", 10);
		applyAvatarMovementLock(char, curState !== GameState.GameOver);
	});
});

// ---------------------------------------------------------------------------
// Input / steering
// ---------------------------------------------------------------------------
let squadX = 0;
let squadZ = PLAYER_Z;
let touchStartX = 0;
let isDragging  = false;
const LANE_LIMIT = PATH_WIDTH / 2 - SQUAD_FORM_R;

UserInputService.TouchStarted.Connect((t) => { isDragging = true; touchStartX = t.Position.X; });
UserInputService.TouchMoved.Connect((t) => {
	if (!isDragging) return;
	squadX = math.clamp(squadX + (t.Position.X - touchStartX) * 0.055, -LANE_LIMIT, LANE_LIMIT);
	touchStartX = t.Position.X;
});
UserInputService.TouchEnded.Connect(() => { isDragging = false; });

// ---------------------------------------------------------------------------
// Camera (shared with render loop + boot)
// ---------------------------------------------------------------------------
function updateFollowCamera(): void {
	const cam = Workspace.CurrentCamera;
	if (cam) {
		cam.CFrame = new CFrame(
			new Vector3(squadX, FLOOR_Y + 18, squadZ + 22),
			new Vector3(squadX, FLOOR_Y,      squadZ - 8),
		);
	}
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
RunService.RenderStepped.Connect((dt: number) => {
	const march =
		curState === GameState.Playing ||
		curState === GameState.BossFight ||
		curState === GameState.WaveComplete;

	if (march) {
		// Keyboard steer
		let steer = 0;
		if (UserInputService.IsKeyDown(Enum.KeyCode.A) || UserInputService.IsKeyDown(Enum.KeyCode.Left))  steer = -1;
		if (UserInputService.IsKeyDown(Enum.KeyCode.D) || UserInputService.IsKeyDown(Enum.KeyCode.Right)) steer =  1;
		squadX = math.clamp(squadX + steer * STEER_SPEED * dt, -LANE_LIMIT, LANE_LIMIT);

		// March forward
		squadZ = math.max(FAR_Z, squadZ - MARCH_SPEED * dt);

		syncEnemyPositions();
		checkGates(squadX, squadZ, currentSquadSize);
		autoShoot(dt, squadX, squadZ);
	}

	// Previously we returned early for Lobby/WaveComplete, so placeSoldiers never ran and
	// no Squad parts were created until Playing — looked like "no team".
	if (curState !== GameState.GameOver) {
		placeSoldiers(squadX, squadZ, currentSquadSize);
		updateFollowCamera();
	}
});

// ---------------------------------------------------------------------------
// Hero ultimate notification
// ---------------------------------------------------------------------------
getHeroUltimateRemote().OnClientEvent.Connect((heroIdx, desc) => {
	const hero = HEROES[heroIdx as number];
	ultNotif.Text    = `★ ${hero.name}: ${desc}`;
	ultNotif.Visible = true;
	task.delay(3, () => { ultNotif.Visible = false; });
});

// ---------------------------------------------------------------------------
// Server event wiring
// ---------------------------------------------------------------------------
// If GameState fires while InvokeServer is yielding, applying stale init would overwrite
// (e.g. Playing → Lobby) and the squad would never march.
let receivedGameStateViaRemote = false;
getGameStateRemote().OnClientEvent.Connect((d) => {
	receivedGameStateViaRemote = true;
	onGameState(d as GameStateData);
});
getEnemySpawnedRemote().OnClientEvent.Connect((d) => spawnEnemyVisual(d as EnemySpawnData));
getEnemyHealthRemote().OnClientEvent.Connect((d)  => updateEnemyVis(d as EnemyHealthData));
getEnemyReachedEndRemote().OnClientEvent.Connect((id) => removeEnemyVis(id as number));
getObstacleSpawnRemote().OnClientEvent.Connect((d)  => spawnObstacleVis(d as ObstacleData));
getObstacleHealthRemote().OnClientEvent.Connect((d) => updateObstacleVis(d as EnemyHealthData));

// Initial state fetch
const init = getRequestStateFunction().InvokeServer() as GameStateData;
if (!receivedGameStateViaRemote) {
	onGameState(init);
}
// curState is updated in onGameState / remote; avoid narrowed-type false positive on curState
if ((curState as GameState) !== GameState.GameOver) {
	placeSoldiers(squadX, squadZ, currentSquadSize);
	updateFollowCamera();
}

// If startGame ran after our first Invoke, we can still be on Lobby until a late GameState arrives.
task.defer(() => {
	if (curState !== GameState.Lobby) return;
	const late = getRequestStateFunction().InvokeServer() as GameStateData;
	onGameState(late);
	if ((curState as GameState) !== GameState.GameOver) {
		placeSoldiers(squadX, squadZ, currentSquadSize);
		updateFollowCamera();
	}
});

print("[ShootingGame] Client ready.");
