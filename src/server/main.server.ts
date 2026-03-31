/**
 * server/main.server.ts
 *
 * Squad Runner Shooting Game – server authority.
 *
 * Game loop (mirrors the screenshots):
 *  1. Player's squad of blue soldiers auto-marches down a bridge.
 *  2. Steering left/right picks a gate side (+5 or -8 style).
 *  3. Enemy red horde + boss enemies march from the far end.
 *  4. When squads meet, auto-combat fires every tick.
 *  5. Wave clears when all enemies are dead; bonus awarded.
 *  6. Game over when squad size reaches 0.
 */

import { Players, RunService, Workspace } from "@rbxts/services";
import {
	PATH_LENGTH,
	PATH_WIDTH,
	TILE_HEIGHT,
	GATE_SPACING,
	WAVE_INTERVAL,
	BASE_ENEMIES_PER_WAVE,
	ENEMY_SPEED,
	ENEMY_BASE_HP,
	SCORE_PER_KILL,
	WAVE_COMPLETION_BONUS,
	GameState,
	randomGatePair,
	type GameStateData,
	type EnemySpawnData,
	type GateData,
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
// Enemy state
// ---------------------------------------------------------------------------

interface EnemyState {
	id: number;
	hp: number;
	maxHp: number;
	isBoss: boolean;
	position: Vector3;
	reachedEnd: boolean;
	dead: boolean;
	part: Part;
}

// ---------------------------------------------------------------------------
// World constants
// ---------------------------------------------------------------------------

const PLAYER_Z = 0;
const ENEMY_SPAWN_Z = PLAYER_Z - PATH_LENGTH;
const PATH_X = 0;
const FLOOR_Y = 0;

// ---------------------------------------------------------------------------
// Mutable game state
// ---------------------------------------------------------------------------

let gameState: GameState = GameState.Lobby;
let currentWave = 0;
let score = 0;
let squadSize = 10;
let multiplier = 1;
let nextEnemyId = 1;
let waveTimer = 0;
let waveInProgress = false;
let combatCooldown = 0;

const activeEnemies = new Map<number, EnemyState>();
const gateMap = new Map<number, GateData>();

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcastState(): void {
	const data: GameStateData = {
		state: gameState,
		wave: currentWave,
		score,
		lives: squadSize,
		multiplier,
	};
	getGameStateRemote().FireAllClients(data);
}

// ---------------------------------------------------------------------------
// Map construction
// ---------------------------------------------------------------------------

function buildMap(): void {
	const mapFolder = new Instance("Folder");
	mapFolder.Name = "GameMap";
	mapFolder.Parent = Workspace;

	// Floor
	const floor = new Instance("Part");
	floor.Name = "Floor";
	floor.Anchored = true;
	floor.Size = new Vector3(PATH_WIDTH, TILE_HEIGHT, PATH_LENGTH);
	floor.Position = new Vector3(PATH_X, FLOOR_Y - TILE_HEIGHT / 2, PLAYER_Z - PATH_LENGTH / 2);
	floor.Material = Enum.Material.Concrete;
	floor.BrickColor = new BrickColor("Medium stone grey");
	floor.Parent = mapFolder;

	// Guardrails
	for (const side of [-1, 1] as const) {
		const rail = new Instance("Part");
		rail.Anchored = true;
		rail.Size = new Vector3(0.6, 3, PATH_LENGTH);
		rail.Position = new Vector3(
			PATH_X + side * (PATH_WIDTH / 2 + 0.3),
			FLOOR_Y + 1.5,
			PLAYER_Z - PATH_LENGTH / 2,
		);
		rail.Material = Enum.Material.Metal;
		rail.BrickColor = new BrickColor("Bright red"); // red rails like Golden Gate
		rail.Parent = mapFolder;
	}

	// Gate panels — alternating positive/negative sides (like "-8 | +5" in screenshot)
	let gateId = 0;
	for (let z = PLAYER_Z - GATE_SPACING; z > ENEMY_SPAWN_Z + GATE_SPACING; z -= GATE_SPACING) {
		gateId++;

		const isUpgradeGate = gateId % 4 === 0; // every 4th gate is a multiplier gate
		let gate: GateData;

		if (isUpgradeGate) {
			gate = {
				id: gateId,
				position: z,
				leftLabel: "x2",
				rightLabel: "+3",
				leftEffect: { type: "multiply", value: 2 },
				rightEffect: { type: "add", value: 3 },
			};
		} else {
			// Random positive/negative pair, like the -8 / +5 gates in the screenshot
			const pair = randomGatePair();
			gate = {
				id: gateId,
				position: z,
				...pair,
			};
		}
		gateMap.set(gateId, gate);

		// Visual panels — left is red (negative), right is blue (positive)
		for (const side of [-1, 1] as const) {
			const isPositiveSide = side > 0;
			const panel = new Instance("Part");
			panel.Name = `Gate_${gateId}_${isPositiveSide ? "Right" : "Left"}`;
			panel.Anchored = true;
			panel.Size = new Vector3(3, 5, 0.5);
			panel.Position = new Vector3(
				PATH_X + side * (PATH_WIDTH / 4),
				FLOOR_Y + 2.5,
				z,
			);
			panel.Material = Enum.Material.SmoothPlastic;
			// Red for negative/lose side, blue for positive/gain side
			panel.BrickColor = isPositiveSide
				? new BrickColor("Bright blue")
				: new BrickColor("Bright red");
			panel.Parent = mapFolder;

			const bb = new Instance("BillboardGui");
			bb.Size = new UDim2(0, 80, 0, 40);
			bb.StudsOffset = new Vector3(0, 3.5, 0);
			bb.AlwaysOnTop = false;
			bb.Parent = panel;

			const lbl = new Instance("TextLabel");
			lbl.Size = new UDim2(1, 0, 1, 0);
			lbl.BackgroundTransparency = 1;
			lbl.TextScaled = true;
			lbl.Font = Enum.Font.GothamBold;
			lbl.TextColor3 = new Color3(1, 1, 1);
			lbl.Text = isPositiveSide ? gate.rightLabel : gate.leftLabel;
			lbl.Parent = bb;
		}
	}
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

function startGame(): void {
	gameState = GameState.Playing;
	currentWave = 0;
	score = 0;
	squadSize = 10;
	multiplier = 1;
	waveTimer = WAVE_INTERVAL;
	waveInProgress = false;
	broadcastState();
}

function endGame(): void {
	gameState = GameState.GameOver;
	activeEnemies.forEach((e) => { if (!e.dead) e.part.Destroy(); });
	activeEnemies.clear();
	broadcastState();
}

// ---------------------------------------------------------------------------
// Enemy spawning
// ---------------------------------------------------------------------------

function spawnEnemy(wave: number, isBoss: boolean): void {
	const id = nextEnemyId++;
	const hp = isBoss
		? (ENEMY_BASE_HP * 10 + wave * 5)
		: (ENEMY_BASE_HP + math.floor(wave / 2));
	const xOff = (math.random() - 0.5) * (PATH_WIDTH - 2);
	const spawnPos = new Vector3(PATH_X + xOff, FLOOR_Y + (isBoss ? 2 : 1), ENEMY_SPAWN_Z);

	const part = new Instance("Part");
	part.Name = `Enemy_${id}`;
	part.Size = isBoss ? new Vector3(4, 7, 4) : new Vector3(2, 3, 2);
	part.Position = spawnPos;
	part.Anchored = true;
	part.CanCollide = false;
	part.Transparency = 1;
	part.Parent = Workspace;

	const enemy: EnemyState = {
		id, hp, maxHp: hp, isBoss,
		position: spawnPos,
		reachedEnd: false, dead: false, part,
	};
	activeEnemies.set(id, enemy);

	const spawnData: EnemySpawnData = { id, position: spawnPos, maxHp: hp };
	getEnemySpawnedRemote().FireAllClients(spawnData);
}

function spawnWave(): void {
	waveInProgress = true;
	currentWave++;
	broadcastState();

	const hordeCount = BASE_ENEMIES_PER_WAVE + (currentWave - 1) * 3;
	for (let i = 0; i < hordeCount; i++) {
		task.delay(i * 0.3, () => spawnEnemy(currentWave, false));
	}
	// Boss spawns every 3 waves, after the horde
	if (currentWave % 3 === 0) {
		task.delay(hordeCount * 0.3 + 1, () => spawnEnemy(currentWave, true));
	}
}

// ---------------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------------

function damageEnemy(enemy: EnemyState, dmg: number): void {
	if (enemy.dead) return;
	enemy.hp = math.max(0, enemy.hp - dmg);
	getEnemyHealthRemote().FireAllClients({ id: enemy.id, hp: enemy.hp, maxHp: enemy.maxHp });
	if (enemy.hp <= 0) {
		enemy.dead = true;
		enemy.part.Destroy();
		activeEnemies.delete(enemy.id);
		score += (enemy.isBoss ? SCORE_PER_KILL * 5 : SCORE_PER_KILL) * multiplier;
		broadcastState();
	}
}

/** Auto-attack: squad fires at closest enemy each tick. Damage scales with squad size. */
function doAutoAttack(): void {
	if (activeEnemies.size() === 0) return;
	let closest: EnemyState | undefined;
	let closestZ = -math.huge;
	activeEnemies.forEach((e) => {
		if (!e.dead && e.position.Z > closestZ) {
			closestZ = e.position.Z;
			closest = e;
		}
	});
	if (!closest) return;
	const damage = math.max(1, math.floor(squadSize * multiplier * 0.15));
	damageEnemy(closest, damage);
}

// ---------------------------------------------------------------------------
// Client event handlers
// ---------------------------------------------------------------------------

function handleShoot(_player: Player, request: { origin: Vector3; direction: Vector3 }): void {
	if (gameState !== GameState.Playing) return;
	const origin = request.origin as Vector3;
	const dir = (request.direction as Vector3).Unit;
	let hit: EnemyState | undefined;
	let bestT = math.huge;
	activeEnemies.forEach((e) => {
		if (e.dead) return;
		const t = e.position.sub(origin).Dot(dir);
		if (t < 0 || t > bestT) return;
		if (origin.add(dir.mul(t)).sub(e.position).Magnitude <= (e.isBoss ? 3 : 1.5)) {
			bestT = t;
			hit = e;
		}
	});
	if (hit) damageEnemy(hit, multiplier);
}

function handleGateTrigger(_player: Player, gateId: number, side: string): void {
	const gate = gateMap.get(gateId);
	if (!gate) return;
	const effect = side === "Right" ? gate.rightEffect : gate.leftEffect;
	if (effect.type === "add") {
		squadSize = math.max(0, squadSize + effect.value);
	} else if (effect.type === "multiply") {
		multiplier *= effect.value;
	} else if (effect.type === "life") {
		squadSize += effect.value;
	}
	if (squadSize <= 0) {
		endGame();
	} else {
		broadcastState();
	}
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

RunService.Heartbeat.Connect((dt: number) => {
	if (gameState !== GameState.Playing) return;

	// Advance enemies toward player end
	activeEnemies.forEach((enemy) => {
		if (enemy.dead || enemy.reachedEnd) return;
		const newZ = enemy.position.Z + ENEMY_SPEED * dt;
		enemy.position = new Vector3(enemy.position.X, enemy.position.Y, newZ);
		enemy.part.Position = enemy.position;

		if (newZ >= PLAYER_Z - 5) {
			enemy.reachedEnd = true;
			enemy.dead = true;
			enemy.part.Destroy();
			activeEnemies.delete(enemy.id);
			getEnemyReachedEndRemote().FireAllClients(enemy.id);
			squadSize = math.max(0, squadSize - (enemy.isBoss ? 5 : 1));
			broadcastState();
			if (squadSize <= 0) endGame();
		}
	});

	if (gameState !== GameState.Playing) return;

	// Auto-attack every 0.25 s
	combatCooldown -= dt;
	if (combatCooldown <= 0) {
		combatCooldown = 0.25;
		if (waveInProgress) doAutoAttack();
	}

	// Wave complete?
	if (waveInProgress && activeEnemies.size() === 0) {
		waveInProgress = false;
		score += WAVE_COMPLETION_BONUS * multiplier;
		gameState = GameState.WaveComplete;
		broadcastState();
		task.delay(3, () => {
			if (gameState === GameState.WaveComplete) {
				gameState = GameState.Playing;
				waveTimer = 0;
				broadcastState();
			}
		});
	}

	// Wave timer
	if (!waveInProgress) {
		waveTimer += dt;
		if (waveTimer >= WAVE_INTERVAL) {
			waveTimer = 0;
			spawnWave();
		}
	}
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

buildMap();

getShootRemote().OnServerEvent.Connect(
	(player, req) => handleShoot(player, req as { origin: Vector3; direction: Vector3 }),
);
getGateTriggerRemote().OnServerEvent.Connect(
	(player, gateId, side) => handleGateTrigger(player, gateId as number, side as string),
);
getRequestStateFunction().OnServerInvoke = (_player: Player): GameStateData => ({
	state: gameState,
	wave: currentWave,
	score,
	lives: squadSize,
	multiplier,
});

Players.PlayerAdded.Connect(() => {
	if (gameState === GameState.Lobby) startGame();
});
if (Players.GetPlayers().size() > 0 && gameState === GameState.Lobby) {
	startGame();
}

print("[ShootingGame] Server ready.");
