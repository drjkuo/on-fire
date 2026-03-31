/**
 * server/main.server.ts
 *
 * Squad Runner Shooting Game – Server Authority
 *
 * Full mechanics (per user's design spec):
 *
 * 1. GATE DECISIONS  – Left/right gate panels carry +N/-N or xN/÷N effects on
 *    squad size.  Client fires GateTrigger; server applies maths and broadcasts.
 *
 * 2. COMBAT          – Squad auto-DPS = squadSize × heroBaseDps × multiplier.
 *    Enemies + obstacles have HP pools; server decrements each tick.
 *
 * 3. OBSTACLES       – Barricades/boxes with HP on the path.  Coloured rescue
 *    boxes free trapped soldiers when destroyed.
 *
 * 4. HEROES          – 5 heroes (2 Tank / 3 Damage) each have an ultimate that
 *    charges over time and fires automatically.
 *
 * 5. BOSS FIGHT      – After every WAVES_PER_BOSS waves the level ends in a
 *    pure DPS check against a high-HP boss.
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
	STARTING_SQUAD,
	SCORE_PER_KILL,
	WAVE_COMPLETION_BONUS,
	WAVES_PER_BOSS,
	GameState,
	HEROES,
	generateGatePair,
	type GameStateData,
	type EnemySpawnData,
	type GateData,
	type ObstacleData,
	type ShootRequest,
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
// World anchors
// ---------------------------------------------------------------------------
const PLAYER_Z   = 0;
const ENEMY_Z    = PLAYER_Z - PATH_LENGTH;
const PATH_X     = 0;
const FLOOR_Y    = 0;

// ---------------------------------------------------------------------------
// Runtime types
// ---------------------------------------------------------------------------

interface EnemyState {
	id: number; hp: number; maxHp: number; isBoss: boolean;
	position: Vector3; reachedEnd: boolean; dead: boolean; part: Part;
}

interface ObstacleState {
	id: number; hp: number; maxHp: number; z: number;
	hasTroops: boolean; troopReward: number; dead: boolean; part: Part;
}

interface HeroState {
	index: number;
	/** Seconds until ultimate is ready again. */
	ultTimer: number;
	/** Whether a shield is currently active (Tank hero). */
	shieldActive: boolean;
	shieldCharges: number;
}

// ---------------------------------------------------------------------------
// Mutable state
// ---------------------------------------------------------------------------

let gameState: GameState = GameState.Lobby;
let currentWave  = 0;
let score        = 0;
let squadSize    = STARTING_SQUAD;
let multiplier   = 1;
let bossHp       = 0;
let bossMaxHp    = 0;
let nextId       = 1;
let waveTimer    = WAVE_INTERVAL; // starts high so first wave fires quickly
let waveInProgress = false;
let combatCooldown = 0;
let fortifyTimer   = 0; // seconds remaining on "Fortify" damage reduction

const activeEnemies   = new Map<number, EnemyState>();
const activeObstacles = new Map<number, ObstacleState>();
const gateMap         = new Map<number, GateData>();
const heroStates: HeroState[] = HEROES.map((_, i) => ({
	index: i,
	ultTimer: HEROES[i].ultimateCooldown,
	shieldActive: false,
	shieldCharges: 0,
}));

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

function snapshotGameState(): GameStateData {
	return {
		state: gameState, wave: currentWave, score,
		squadSize, multiplier, bossHp, bossMaxHp,
	} as GameStateData;
}

function broadcast(): void {
	getGameStateRemote().FireAllClients(snapshotGameState());
}

/** Ensures the client gets a GameState after its RemoteEvent listener exists (FireAllClients can fire too early). */
function deferPushStateToPlayer(player: Player): void {
	task.defer(() => {
		getGameStateRemote().FireClient(player, snapshotGameState());
	});
}

// ---------------------------------------------------------------------------
// Map construction
// ---------------------------------------------------------------------------

function buildMap(): void {
	const map = new Instance("Folder");
	map.Name = "GameMap";
	map.Parent = Workspace;

	// Floor
	const floor = new Instance("Part");
	floor.Name = "Floor"; floor.Anchored = true;
	floor.Size = new Vector3(PATH_WIDTH, TILE_HEIGHT, PATH_LENGTH);
	floor.Position = new Vector3(PATH_X, FLOOR_Y - TILE_HEIGHT / 2, PLAYER_Z - PATH_LENGTH / 2);
	floor.Material = Enum.Material.Concrete;
	floor.BrickColor = new BrickColor("Medium stone grey");
	floor.Parent = map;

	// Red bridge rails (Golden Gate style)
	for (const side of [-1, 1] as const) {
		const rail = new Instance("Part");
		rail.Anchored = true;
		rail.Size = new Vector3(0.7, 4, PATH_LENGTH);
		rail.Position = new Vector3(PATH_X + side * (PATH_WIDTH / 2 + 0.35), FLOOR_Y + 2, PLAYER_Z - PATH_LENGTH / 2);
		rail.Material = Enum.Material.Metal;
		rail.BrickColor = new BrickColor("Bright red");
		rail.Parent = map;
	}

	// Gates
	let gateId = 0;
	for (let z = PLAYER_Z - GATE_SPACING; z > ENEMY_Z + GATE_SPACING; z -= GATE_SPACING) {
		gateId++;
		const pair = generateGatePair(1, STARTING_SQUAD); // initial layout
		const gate: GateData = { id: gateId, z, ...pair };
		gateMap.set(gateId, gate);

		for (const side of [-1, 1] as const) {
			const positive = side > 0;
			const panel = new Instance("Part");
			panel.Name = `Gate_${gateId}_${positive ? "Right" : "Left"}`;
			panel.Anchored = true;
			panel.Size = new Vector3(3.5, 6, 0.5);
			panel.Position = new Vector3(PATH_X + side * (PATH_WIDTH / 4), FLOOR_Y + 3, z);
			panel.Material = Enum.Material.SmoothPlastic;
			panel.BrickColor = positive ? new BrickColor("Bright blue") : new BrickColor("Bright red");
			panel.Parent = map;

			const bb = new Instance("BillboardGui");
			bb.Size = new UDim2(0, 90, 0, 45);
			bb.StudsOffset = new Vector3(0, 4, 0);
			bb.AlwaysOnTop = false;
			bb.Parent = panel;

			const lbl = new Instance("TextLabel");
			lbl.Size = new UDim2(1, 0, 1, 0);
			lbl.BackgroundTransparency = 1;
			lbl.TextScaled = true;
			lbl.Font = Enum.Font.GothamBold;
			lbl.TextStrokeTransparency = 0;
			lbl.TextColor3 = new Color3(1, 1, 1);
			lbl.Text = positive ? gate.rightLabel : gate.leftLabel;
			lbl.Parent = bb;
		}
	}

	// Obstacles (barricades) at fixed intervals
	const obstacleZs = [PLAYER_Z - 25, PLAYER_Z - 45, PLAYER_Z - 65];
	for (const z of obstacleZs) {
		spawnObstacle(z, math.random(0, 1) === 1);
	}
}

// ---------------------------------------------------------------------------
// Obstacles
// ---------------------------------------------------------------------------

function spawnObstacle(z: number, hasTroops: boolean): void {
	const id = nextId++;
	const hp = 20 + currentWave * 5;
	const reward = hasTroops ? math.random(3, 8) : 0;

	const part = new Instance("Part");
	part.Name = `Obstacle_${id}`;
	part.Anchored = true;
	part.Size = new Vector3(PATH_WIDTH - 2, 4, 2);
	part.Position = new Vector3(PATH_X, FLOOR_Y + 2, z);
	part.Material = Enum.Material.WoodPlanks;
	part.BrickColor = hasTroops ? new BrickColor("Bright yellow") : new BrickColor("Brown");
	part.CanCollide = false;
	part.Parent = Workspace;

	// HP billboard
	const bb = new Instance("BillboardGui");
	bb.Size = new UDim2(0, 100, 0, 30);
	bb.StudsOffset = new Vector3(0, 3, 0);
	bb.AlwaysOnTop = false;
	bb.Parent = part;
	const lbl = new Instance("TextLabel");
	lbl.Size = new UDim2(1, 0, 1, 0);
	lbl.BackgroundTransparency = 1;
	lbl.TextScaled = true;
	lbl.Font = Enum.Font.GothamBold;
	lbl.TextColor3 = new Color3(1, 1, 1);
	lbl.Text = tostring(hp);
	lbl.Name = "HpLabel";
	lbl.Parent = bb;

	const obs: ObstacleState = { id, hp, maxHp: hp, z, hasTroops, troopReward: reward, dead: false, part };
	activeObstacles.set(id, obs);

	const data: ObstacleData = { id, position: part.Position, hp, hasTroops, troopReward: reward };
	getObstacleSpawnRemote().FireAllClients(data);
}

function damageObstacle(obs: ObstacleState, dmg: number): void {
	if (obs.dead) return;
	obs.hp = math.max(0, obs.hp - dmg);

	// Update billboard
	const lbl = obs.part.FindFirstChild("BillboardGui")?.FindFirstChild("HpLabel") as TextLabel | undefined;
	if (lbl) lbl.Text = tostring(obs.hp);

	getObstacleHealthRemote().FireAllClients({ id: obs.id, hp: obs.hp, maxHp: obs.maxHp });

	if (obs.hp <= 0) {
		obs.dead = true;
		obs.part.Destroy();
		activeObstacles.delete(obs.id);
		if (obs.hasTroops) {
			squadSize += obs.troopReward;
			broadcast();
		}
	}
}

// ---------------------------------------------------------------------------
// Enemies
// ---------------------------------------------------------------------------

function spawnEnemy(wave: number, isBoss: boolean): void {
	const id = nextId++;
	const hp = isBoss ? (50 + wave * 20) : (ENEMY_BASE_HP + math.floor(wave * 1.5));
	const xOff = (math.random() - 0.5) * (PATH_WIDTH - 3);
	const pos = new Vector3(PATH_X + xOff, FLOOR_Y + (isBoss ? 3 : 1.5), ENEMY_Z);

	if (isBoss) {
		bossHp = hp; bossMaxHp = hp;
		gameState = GameState.BossFight;
		broadcast();
	}

	const part = new Instance("Part");
	part.Name = `Enemy_${id}`;
	part.Size = isBoss ? new Vector3(5, 8, 5) : new Vector3(2, 3, 2);
	part.Position = pos; part.Anchored = true;
	part.CanCollide = false; part.Transparency = 1;
	part.Parent = Workspace;

	const enemy: EnemyState = { id, hp, maxHp: hp, isBoss, position: pos, reachedEnd: false, dead: false, part };
	activeEnemies.set(id, enemy);

	getEnemySpawnedRemote().FireAllClients({ id, position: pos, maxHp: hp, isBoss } as EnemySpawnData);
}

function damageEnemy(enemy: EnemyState, dmg: number): void {
	if (enemy.dead) return;
	enemy.hp = math.max(0, enemy.hp - dmg);
	getEnemyHealthRemote().FireAllClients({ id: enemy.id, hp: enemy.hp, maxHp: enemy.maxHp });

	if (enemy.isBoss) { bossHp = enemy.hp; }

	if (enemy.hp <= 0) {
		enemy.dead = true;
		enemy.part.Destroy();
		activeEnemies.delete(enemy.id);
		score += (enemy.isBoss ? SCORE_PER_KILL * 10 : SCORE_PER_KILL) * multiplier;
		if (enemy.isBoss) {
			bossHp = 0;
			gameState = GameState.WaveComplete;
		}
		broadcast();
	}
}

// ---------------------------------------------------------------------------
// Hero ultimates
// ---------------------------------------------------------------------------

function tickHeroes(dt: number): void {
	for (const hs of heroStates) {
		hs.ultTimer -= dt;
		if (hs.ultTimer > 0) continue;

		const hero = HEROES[hs.index];
		hs.ultTimer = hero.ultimateCooldown;
		getHeroUltimateRemote().FireAllClients(hs.index, hero.ultimateDesc);

		if (hero.name === "Shield Guard") {
			hs.shieldActive = true;
			hs.shieldCharges = 10;
		} else if (hero.name === "Iron Wall") {
			fortifyTimer = 5;
		} else if (hero.name === "Gatling Ace") {
			// Temporarily triple DPS: handled as a 4-second burst flag
			const origMult = multiplier;
			multiplier *= 3;
			broadcast();
			task.delay(8, () => { multiplier = origMult; broadcast(); });
		} else if (hero.name === "Rocket Commander") {
			// 100 damage to ALL enemies
			activeEnemies.forEach((e) => damageEnemy(e, 100));
		} else if (hero.name === "Helicopter Pilot") {
			// 200 damage to boss
			activeEnemies.forEach((e) => { if (e.isBoss) damageEnemy(e, 200); });
		}
	}
}

// ---------------------------------------------------------------------------
// Auto-DPS
// ---------------------------------------------------------------------------

/** Total DPS from squad + heroes. */
function calcDps(): number {
	let heroDps = 0;
	for (const hero of HEROES) heroDps += hero.attackDps;
	return (squadSize * 0.2 + heroDps) * multiplier;
}

function doAutoAttack(): void {
	// 1. Attack nearest enemy
	let closest: EnemyState | undefined;
	let closestZ = -math.huge;
	activeEnemies.forEach((e) => {
		if (!e.dead && e.position.Z > closestZ) { closestZ = e.position.Z; closest = e; }
	});
	if (closest) damageEnemy(closest, calcDps() * 0.25); // per tick (0.25 s)

	// 2. Damage obstacles in range of squad Z (estimated as PLAYER_Z - PATH_LENGTH * 0.3)
	const squadZ = PLAYER_Z - PATH_LENGTH * 0.1; // approximate – client has real pos
	activeObstacles.forEach((obs) => {
		if (math.abs(obs.z - squadZ) < 8) {
			damageObstacle(obs, calcDps() * 0.25);
		}
	});
}

// ---------------------------------------------------------------------------
// Wave management
// ---------------------------------------------------------------------------

function startWave(): void {
	waveInProgress = true;
	currentWave++;
	// Regenerate gate labels each wave with scaling difficulty
	gateMap.forEach((gate) => {
		const pair = generateGatePair(currentWave, squadSize);
		gate.leftLabel   = pair.leftLabel;
		gate.rightLabel  = pair.rightLabel;
		gate.leftEffect  = pair.leftEffect;
		gate.rightEffect = pair.rightEffect;
	});
	broadcast();

	const isBossWave = currentWave % WAVES_PER_BOSS === 0;
	if (isBossWave) {
		// Spawn boss only (no horde)
		task.delay(2, () => spawnEnemy(currentWave, true));
	} else {
		const count = BASE_ENEMIES_PER_WAVE + (currentWave - 1) * 2;
		for (let i = 0; i < count; i++) {
			task.delay(i * 0.7, () => spawnEnemy(currentWave, false));
		}
	}
}

function startGame(): void {
	gameState = GameState.Playing;
	currentWave = 0; score = 0;
	squadSize = STARTING_SQUAD; multiplier = 1;
	bossHp = 0; bossMaxHp = 0;
	waveTimer = WAVE_INTERVAL; waveInProgress = false;
	heroStates.forEach((hs, i) => {
		hs.ultTimer = HEROES[i].ultimateCooldown;
		hs.shieldActive = false; hs.shieldCharges = 0;
	});
	broadcast();
}

function endGame(): void {
	gameState = GameState.GameOver;
	activeEnemies.forEach((e) => { if (!e.dead) e.part.Destroy(); });
	activeEnemies.clear();
	broadcast();
}

// ---------------------------------------------------------------------------
// Gate trigger (client fires when squad walks through panel)
// ---------------------------------------------------------------------------

function handleGateTrigger(_player: Player, gateId: number, side: string): void {
	const gate = gateMap.get(gateId);
	if (!gate) return;
	const effect = side === "Right" ? gate.rightEffect : gate.leftEffect;

	if (effect.type === "add") {
		squadSize = math.max(0, squadSize + effect.value);
	} else {
		squadSize = math.max(1, math.floor(squadSize * effect.value));
	}

	if (squadSize <= 0) {
		endGame();
	} else {
		broadcast();
	}
}

// ---------------------------------------------------------------------------
// Shoot (client fires when auto-shoot fires a ray)
// ---------------------------------------------------------------------------

function handleShoot(_player: Player, req: ShootRequest): void {
	if (gameState !== GameState.Playing && gameState !== GameState.BossFight) return;
	const origin = req.origin;
	const dir    = req.direction.Unit;
	let best: EnemyState | undefined;
	let bestT = math.huge;
	activeEnemies.forEach((e) => {
		if (e.dead) return;
		const t = e.position.sub(origin).Dot(dir);
		if (t < 0 || t > bestT) return;
		if (origin.add(dir.mul(t)).sub(e.position).Magnitude <= (e.isBoss ? 3.5 : 2)) {
			bestT = t; best = e;
		}
	});
	if (best) damageEnemy(best, multiplier);
}

// ---------------------------------------------------------------------------
// Main heartbeat
// ---------------------------------------------------------------------------

RunService.Heartbeat.Connect((dt: number) => {
	if (gameState !== GameState.Playing && gameState !== GameState.BossFight) return;

	// Move enemies
	activeEnemies.forEach((e) => {
		if (e.dead || e.reachedEnd) return;
		const speed = e.isBoss ? ENEMY_SPEED * 0.6 : ENEMY_SPEED;
		e.position = new Vector3(e.position.X, e.position.Y, e.position.Z + speed * dt);
		e.part.Position = e.position;

		if (e.position.Z >= PLAYER_Z - 5) {
			e.reachedEnd = true; e.dead = true;
			e.part.Destroy(); activeEnemies.delete(e.id);
			getEnemyReachedEndRemote().FireAllClients(e.id);

			// Shield absorbs hits
			const tank = heroStates[0];
			if (tank.shieldActive && tank.shieldCharges > 0) {
				tank.shieldCharges--;
				if (tank.shieldCharges === 0) tank.shieldActive = false;
			} else {
				const dmgReduction = fortifyTimer > 0 ? 0.5 : 1;
				const lost = e.isBoss ? math.floor(8 * dmgReduction) : math.floor(1 * dmgReduction);
				squadSize = math.max(0, squadSize - lost);
			}
			broadcast();
			if (squadSize <= 0) { endGame(); return; }
		}
	});

	if (fortifyTimer > 0) fortifyTimer -= dt;

	if (gameState !== GameState.Playing && gameState !== GameState.BossFight) return;

	// Auto-attack + hero tick
	combatCooldown -= dt;
	if (combatCooldown <= 0) {
		combatCooldown = 0.25;
		doAutoAttack();
	}
	tickHeroes(dt);

	// Wave complete check
	if (waveInProgress && activeEnemies.size() === 0) {
		waveInProgress = false;
		score += WAVE_COMPLETION_BONUS * multiplier;
		gameState = GameState.WaveComplete;
		broadcast();
		task.delay(6, () => {
			if (gameState === GameState.WaveComplete) {
				gameState = GameState.Playing;
				waveTimer = 0;
				broadcast();
			}
		});
	}

	// Wave timer
	if (!waveInProgress && gameState === GameState.Playing) {
		waveTimer += dt;
		if (waveTimer >= WAVE_INTERVAL) { waveTimer = 0; startWave(); }
	}
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

buildMap();

getShootRemote().OnServerEvent.Connect(
	(p, r) => handleShoot(p, r as ShootRequest),
);
getGateTriggerRemote().OnServerEvent.Connect(
	(p, gateId, side) => handleGateTrigger(p, gateId as number, side as string),
);
getRequestStateFunction().OnServerInvoke = (_p: Player): GameStateData => ({
	state: gameState, wave: currentWave, score,
	squadSize, multiplier, bossHp, bossMaxHp,
});

Players.PlayerAdded.Connect((player) => {
	if (gameState === GameState.Lobby) startGame();
	deferPushStateToPlayer(player);
});
if (Players.GetPlayers().size() > 0 && gameState === GameState.Lobby) startGame();
task.defer(() => {
	for (const player of Players.GetPlayers()) {
		getGameStateRemote().FireClient(player, snapshotGameState());
	}
});

print("[ShootingGame] Server ready – full mechanics loaded.");
