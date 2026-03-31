/**
 * client/main.client.ts
 *
 * Squad Runner Shooting Game – client visuals + input.
 *
 * Responsibilities:
 *  - Render the player's squad of blue soldiers (NPCs that follow the camera)
 *  - Render enemy soldiers / bosses with health bars
 *  - Handle left/right lane steering (moves squad into gate panels)
 *  - Show HUD: wave, score, squad size, multiplier
 *  - Fire projectile visual effects when shooting
 *  - React to server state broadcasts
 */

import { Players, UserInputService, RunService, Workspace, TweenService } from "@rbxts/services";
import {
	PATH_WIDTH,
	FLOOR_Y,
	GameState,
	type GameStateData,
	type EnemySpawnData,
	type EnemyHealthData,
} from "../shared/types";
import {
	getGameStateRemote,
	getEnemySpawnedRemote,
	getEnemyHealthRemote,
	getEnemyReachedEndRemote,
	getShootRemote,
	getGateTriggerRemote,
	getRequestStateFunction,
} from "../shared/remotes";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SQUAD_MARCH_SPEED = 8;          // studs/s forward (toward enemies)
const SQUAD_STEER_SPEED = 12;         // studs/s lateral steering
const SQUAD_Z_PLAYER = 0;             // player start Z
const SQUAD_Z_END    = -55;           // far end of bridge (enemies spawn here)
const SQUAD_FORMATION_RADIUS = 3;     // how spread out the formation is
const MAX_SQUAD_VISUAL = 30;          // cap on rendered soldier parts

// ---------------------------------------------------------------------------
// HUD setup
// ---------------------------------------------------------------------------

const player = Players.LocalPlayer;
const playerGui = player.WaitForChild("PlayerGui") as PlayerGui;

const screenGui = new Instance("ScreenGui");
screenGui.Name = "GameHUD";
screenGui.ResetOnSpawn = false;
screenGui.Parent = playerGui;

// Top bar
const topBar = new Instance("Frame");
topBar.Size = new UDim2(1, 0, 0, 60);
topBar.Position = new UDim2(0, 0, 0, 0);
topBar.BackgroundColor3 = new Color3(0, 0, 0);
topBar.BackgroundTransparency = 0.4;
topBar.Parent = screenGui;

function makeLabel(text: string, x: number, width: number): TextLabel {
	const lbl = new Instance("TextLabel");
	lbl.Size = new UDim2(0, width, 1, 0);
	lbl.Position = new UDim2(0, x, 0, 0);
	lbl.BackgroundTransparency = 1;
	lbl.Font = Enum.Font.GothamBold;
	lbl.TextColor3 = new Color3(1, 1, 1);
	lbl.TextScaled = true;
	lbl.Text = text;
	lbl.Parent = topBar;
	return lbl;
}

const waveLabel     = makeLabel("Wave 0",   10,  160);
const scoreLabel    = makeLabel("Score 0",  180, 200);
const squadLabel    = makeLabel("Squad 10", 390, 200);
const multLabel     = makeLabel("x1",       600, 120);

// Wave complete / game over overlay
const overlay = new Instance("Frame");
overlay.Size = new UDim2(1, 0, 1, 0);
overlay.BackgroundColor3 = new Color3(0, 0, 0);
overlay.BackgroundTransparency = 0.5;
overlay.Visible = false;
overlay.Parent = screenGui;

const overlayLabel = new Instance("TextLabel");
overlayLabel.Size = new UDim2(0.6, 0, 0.2, 0);
overlayLabel.Position = new UDim2(0.2, 0, 0.4, 0);
overlayLabel.BackgroundTransparency = 1;
overlayLabel.Font = Enum.Font.GothamBold;
overlayLabel.TextColor3 = new Color3(1, 1, 0);
overlayLabel.TextScaled = true;
overlayLabel.Text = "";
overlayLabel.Parent = overlay;

// ---------------------------------------------------------------------------
// Squad rendering
// ---------------------------------------------------------------------------

interface SoldierVisual {
	root: Part;
	head: Part;
}

const soldierFolder = new Instance("Folder");
soldierFolder.Name = "PlayerSquad";
soldierFolder.Parent = Workspace;

const soldiers: SoldierVisual[] = [];

function makeSoldier(): SoldierVisual {
	const root = new Instance("Part");
	root.Size = new Vector3(1.2, 1.8, 1.2);
	root.Anchored = true;
	root.CanCollide = false;
	root.Material = Enum.Material.SmoothPlastic;
	root.BrickColor = new BrickColor("White");
	root.Parent = soldierFolder;

	const head = new Instance("Part");
	head.Size = new Vector3(1.2, 1.2, 1.2);
	head.Anchored = true;
	head.CanCollide = false;
	head.Shape = Enum.PartType.Ball;
	head.Material = Enum.Material.SmoothPlastic;
	head.BrickColor = new BrickColor("Bright blue");
	head.Parent = soldierFolder;

	return { root, head };
}

function updateSquadVisuals(count: number, centerX: number, centerZ: number): void {
	const target = math.min(count, MAX_SQUAD_VISUAL);

	// Add missing soldiers
	while (soldiers.size() < target) {
		soldiers.push(makeSoldier());
	}
	// Hide excess
	for (let i = 0; i < soldiers.size(); i++) {
		const visible = i < target;
		soldiers[i].root.Transparency = visible ? 0 : 1;
		soldiers[i].head.Transparency = visible ? 0 : 1;
	}
	// Position in grid formation
	for (let i = 0; i < target; i++) {
		const cols = math.ceil(math.sqrt(target));
		const col = i % cols;
		const row = math.floor(i / cols);
		const xOff = (col - cols / 2) * 1.4;
		const zOff = (row - math.ceil(target / cols) / 2) * 1.4;
		const pos = new Vector3(centerX + xOff, FLOOR_Y + 0.9, centerZ + zOff);
		soldiers[i].root.Position = pos;
		soldiers[i].head.Position = new Vector3(pos.X, pos.Y + 1.5, pos.Z);
	}
}

// ---------------------------------------------------------------------------
// Enemy visuals
// ---------------------------------------------------------------------------

interface EnemyVisual {
	body: Part;
	head: Part;
	healthBar: Frame;
	healthFill: Frame;
	billboard: BillboardGui;
	maxHp: number;
}

const enemyFolder = new Instance("Folder");
enemyFolder.Name = "EnemyVisuals";
enemyFolder.Parent = Workspace;

const enemyVisuals = new Map<number, EnemyVisual>();

function createEnemyVisual(data: EnemySpawnData): void {
	const isBoss = data.maxHp > 20;

	const body = new Instance("Part");
	body.Size = isBoss ? new Vector3(4, 6, 4) : new Vector3(1.8, 2.5, 1.8);
	body.Anchored = true;
	body.CanCollide = false;
	body.Material = Enum.Material.SmoothPlastic;
	body.BrickColor = isBoss ? new BrickColor("Bright red") : new BrickColor("Bright red");
	body.Position = data.position;
	body.Parent = enemyFolder;

	const head = new Instance("Part");
	head.Size = isBoss ? new Vector3(3, 3, 3) : new Vector3(1.6, 1.6, 1.6);
	head.Anchored = true;
	head.CanCollide = false;
	head.Shape = Enum.PartType.Ball;
	head.BrickColor = new BrickColor("Reddish brown");
	head.Position = data.position.add(new Vector3(0, isBoss ? 4.5 : 2, 0));
	head.Parent = enemyFolder;

	// Health bar billboard
	const bb = new Instance("BillboardGui");
	bb.Size = new UDim2(0, isBoss ? 120 : 70, 0, isBoss ? 20 : 12);
	bb.StudsOffset = new Vector3(0, isBoss ? 6 : 3, 0);
	bb.AlwaysOnTop = false;
	bb.Parent = body;

	const bg = new Instance("Frame");
	bg.Size = new UDim2(1, 0, 1, 0);
	bg.BackgroundColor3 = new Color3(0.2, 0.2, 0.2);
	bg.BorderSizePixel = 0;
	bg.Parent = bb;

	const fill = new Instance("Frame");
	fill.Size = new UDim2(1, 0, 1, 0);
	fill.BackgroundColor3 = new Color3(1, 0.1, 0.1);
	fill.BorderSizePixel = 0;
	fill.Parent = bg;

	enemyVisuals.set(data.id, {
		body, head,
		healthBar: bg,
		healthFill: fill,
		billboard: bb,
		maxHp: data.maxHp,
	});
}

function updateEnemyHealth(data: EnemyHealthData): void {
	const vis = enemyVisuals.get(data.id);
	if (!vis) return;
	const pct = data.hp / data.maxHp;
	vis.healthFill.Size = new UDim2(pct, 0, 1, 0);
	if (data.hp <= 0) {
		// Death flash then remove
		vis.body.BrickColor = new BrickColor("Bright yellow");
		task.delay(0.15, () => {
			vis.body.Destroy();
			vis.head.Destroy();
			enemyVisuals.delete(data.id);
		});
	}
}

function removeEnemyVisual(id: number): void {
	const vis = enemyVisuals.get(id);
	if (!vis) return;
	vis.body.Destroy();
	vis.head.Destroy();
	enemyVisuals.delete(id);
}

// Sync enemy part positions from server-side (server moves the invisible parts,
// we mirror their position here every frame).
function syncEnemyPositions(): void {
	enemyVisuals.forEach((vis, id) => {
		const serverPart = Workspace.FindFirstChild(`Enemy_${id}`) as Part | undefined;
		if (!serverPart) return;
		const pos = serverPart.Position;
		vis.body.Position = pos;
		vis.head.Position = pos.add(new Vector3(0, vis.maxHp > 20 ? 4.5 : 2, 0));
	});
}

// ---------------------------------------------------------------------------
// Projectile visual
// ---------------------------------------------------------------------------

function spawnProjectileEffect(origin: Vector3, direction: Vector3): void {
	const proj = new Instance("Part");
	proj.Size = new Vector3(0.3, 0.3, 1.2);
	proj.Anchored = true;
	proj.CanCollide = false;
	proj.Material = Enum.Material.Neon;
	proj.BrickColor = new BrickColor("Bright yellow");
	proj.CFrame = new CFrame(origin, origin.add(direction));
	proj.Parent = Workspace;

	const goal = { Position: origin.add(direction.mul(50)) };
	const tween = TweenService.Create(proj, new TweenInfo(0.35, Enum.EasingStyle.Linear), goal);
	tween.Play();
	tween.Completed.Connect(() => proj.Destroy());
}

// ---------------------------------------------------------------------------
// Input / squad steering
// ---------------------------------------------------------------------------

let squadX = 0;         // current lateral position of squad centre
let squadZ = SQUAD_Z_PLAYER; // current forward position

let currentState: GameState = GameState.Lobby;
let currentSquadSize = 10;
let touchStartX = 0;
let isDragging = false;

// Track which gate panels were already triggered to avoid double-fire
const triggeredGates = new Set<string>();

function checkGateTriggers(): void {
	// Scan gate panels near squad Z
	Workspace.FindFirstChild("GameMap")?.GetChildren().forEach((child) => {
		const part = child as Part;
		if (!part.Name.match("^Gate_")) return;

		const diff = part.Position.Z - squadZ;
		if (math.abs(diff) > 1) return; // not near this gate Z
		if (math.abs(part.Position.X - squadX) > PATH_WIDTH / 4 + 1) return; // not in this lane

		if (triggeredGates.has(part.Name)) return;
		triggeredGates.add(part.Name);

		// Parse gate id and side from name "Gate_<id>_Left" / "Gate_<id>_Right"
		const parts = part.Name.split("_");
		if (parts.size() < 3) return;
		const gateId = tonumber(parts[1]);
		const side = parts[2];
		if (!gateId) return;

		getGateTriggerRemote().FireServer(gateId, side);

		// Visual flash on the panel
		const orig = part.BrickColor;
		part.BrickColor = new BrickColor("White");
		task.delay(0.2, () => { part.BrickColor = orig; });
	});
}

// ---------------------------------------------------------------------------
// Auto-shoot toward nearest enemy
// ---------------------------------------------------------------------------

let shootCooldown = 0;

function autoShoot(dt: number): void {
	if (currentState !== GameState.Playing) return;
	shootCooldown -= dt;
	if (shootCooldown > 0) return;
	shootCooldown = 0.15; // fire rate

	// Find nearest visible enemy
	let nearestPos: Vector3 | undefined;
	let nearestDist = math.huge;
	enemyVisuals.forEach((vis) => {
		const d = vis.body.Position.sub(new Vector3(squadX, FLOOR_Y + 1, squadZ)).Magnitude;
		if (d < nearestDist) {
			nearestDist = d;
			nearestPos = vis.body.Position;
		}
	});

	if (!nearestPos) return;

	const origin = new Vector3(squadX, FLOOR_Y + 1.5, squadZ - 1);
	const direction = nearestPos.sub(origin).Unit;

	// Spawn several projectile visuals (one per row of squad for flavor)
	const rows = math.ceil(math.sqrt(math.min(currentSquadSize, MAX_SQUAD_VISUAL)));
	for (let r = 0; r < rows; r++) {
		const xOff = (r - rows / 2) * 1.4;
		spawnProjectileEffect(
			new Vector3(origin.X + xOff, origin.Y, origin.Z),
			direction,
		);
	}

	// Tell server
	getShootRemote().FireServer({ origin, direction });
}

// ---------------------------------------------------------------------------
// Game state updates
// ---------------------------------------------------------------------------

function onGameState(data: GameStateData): void {
	currentState = data.state;
	currentSquadSize = data.lives; // server repurposes "lives" as squadSize

	waveLabel.Text  = `Wave ${data.wave}`;
	scoreLabel.Text = `Score ${data.score}`;
	squadLabel.Text = `Squad ${data.lives}`;
	multLabel.Text  = `x${data.multiplier}`;

	if (data.state === GameState.WaveComplete) {
		overlay.Visible = true;
		overlayLabel.Text = `Wave ${data.wave} Clear! +${50 * data.multiplier}`;
		task.delay(2.5, () => { overlay.Visible = false; });
	} else if (data.state === GameState.GameOver) {
		overlay.Visible = true;
		overlayLabel.Text = `GAME OVER\nScore: ${data.score}`;
	} else {
		overlay.Visible = false;
	}
}

// ---------------------------------------------------------------------------
// Main render loop
// ---------------------------------------------------------------------------

RunService.RenderStepped.Connect((dt: number) => {
	if (currentState !== GameState.Playing) return;

	// Steer left/right with A/D or arrow keys or touch drag
	let steerDir = 0;
	if (UserInputService.IsKeyDown(Enum.KeyCode.A) || UserInputService.IsKeyDown(Enum.KeyCode.Left)) {
		steerDir = -1;
	} else if (UserInputService.IsKeyDown(Enum.KeyCode.D) || UserInputService.IsKeyDown(Enum.KeyCode.Right)) {
		steerDir = 1;
	}
	squadX = math.clamp(
		squadX + steerDir * SQUAD_STEER_SPEED * dt,
		-(PATH_WIDTH / 2 - SQUAD_FORMATION_RADIUS),
		 (PATH_WIDTH / 2 - SQUAD_FORMATION_RADIUS),
	);

	// March forward (toward enemies)
	squadZ = math.max(SQUAD_Z_END, squadZ - SQUAD_MARCH_SPEED * dt);

	// Sync squad visuals
	updateSquadVisuals(currentSquadSize, squadX, squadZ);

	// Sync enemy positions from server
	syncEnemyPositions();

	// Check gate triggers
	checkGateTriggers();

	// Auto-shoot
	autoShoot(dt);

	// Camera follows squad
	const cam = Workspace.CurrentCamera;
	if (cam) {
		const target = new Vector3(squadX, FLOOR_Y + 15, squadZ + 20);
		const lookAt = new Vector3(squadX, FLOOR_Y, squadZ - 10);
		cam.CFrame = new CFrame(target, lookAt);
	}
});

// Touch / mobile steering
UserInputService.TouchStarted.Connect((touch) => {
	isDragging = true;
	touchStartX = touch.Position.X;
});
UserInputService.TouchMoved.Connect((touch) => {
	if (!isDragging) return;
	const delta = touch.Position.X - touchStartX;
	touchStartX = touch.Position.X;
	squadX = math.clamp(
		squadX + delta * 0.05,
		-(PATH_WIDTH / 2 - SQUAD_FORMATION_RADIUS),
		 (PATH_WIDTH / 2 - SQUAD_FORMATION_RADIUS),
	);
});
UserInputService.TouchEnded.Connect(() => { isDragging = false; });

// ---------------------------------------------------------------------------
// Wire up server remotes
// ---------------------------------------------------------------------------

getGameStateRemote().OnClientEvent.Connect((data) => onGameState(data as GameStateData));
getEnemySpawnedRemote().OnClientEvent.Connect((data) => createEnemyVisual(data as EnemySpawnData));
getEnemyHealthRemote().OnClientEvent.Connect((data) => updateEnemyHealth(data as EnemyHealthData));
getEnemyReachedEndRemote().OnClientEvent.Connect((id) => removeEnemyVisual(id as number));

// Fetch initial state
const initState = getRequestStateFunction().InvokeServer() as GameStateData;
onGameState(initState);

print("[ShootingGame] Client ready.");
