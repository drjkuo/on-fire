/**
 * shared/types.ts
 * Shared type definitions and constants for the Squad Runner shooting game.
 */

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------

export const PATH_LENGTH = 80;
export const PATH_WIDTH = 12;
export const TILE_HEIGHT = 1;
export const FLOOR_Y = 0;

/** Gap between gate pairs along the path. */
export const GATE_SPACING = 15;

/** Seconds between wave spawns. */
export const WAVE_INTERVAL = 10;

/** Base horde size for wave 1. */
export const BASE_ENEMIES_PER_WAVE = 8;

/** Enemy walk speed (studs/s). */
export const ENEMY_SPEED = 5;

/** Base HP for regular enemies. */
export const ENEMY_BASE_HP = 4;

/** Starting squad size. */
export const STARTING_SQUAD = 15;

/** Score per kill. */
export const SCORE_PER_KILL = 10;

/** Bonus score per wave clear. */
export const WAVE_COMPLETION_BONUS = 100;

/** How many waves before the boss fight. */
export const WAVES_PER_BOSS = 3;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

export const enum GameState {
	Lobby        = "Lobby",
	Playing      = "Playing",
	WaveComplete = "WaveComplete",
	BossFight    = "BossFight",
	GameOver     = "GameOver",
}

export const enum HeroRole {
	Tank   = "Tank",   // front row – shield ability
	Damage = "Damage", // back row – heavy fire
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Full game snapshot broadcast to clients whenever state changes. */
export interface GameStateData {
	state: GameState;
	wave: number;
	score: number;
	/** Current squad troop count (also used as effective HP). */
	squadSize: number;
	multiplier: number;
	/** Remaining HP of the active boss (0 if no boss). */
	bossHp: number;
	bossMaxHp: number;
}

/** Describes one gate panel pair placed along the path. */
export interface GateData {
	id: number;
	/** World Z of the gate. */
	z: number;
	leftLabel: string;
	rightLabel: string;
	leftEffect: GateEffect;
	rightEffect: GateEffect;
}

/** Effect applied to squad size when walking through a gate panel. */
export interface GateEffect {
	/** "add" = squadSize += value (can be negative), "multiply" = squadSize *= value */
	type: "add" | "multiply";
	value: number;
}

/** Minimal data the client needs to render a spawned enemy. */
export interface EnemySpawnData {
	id: number;
	position: Vector3;
	maxHp: number;
	isBoss: boolean;
}

/** HP change for an enemy or obstacle. */
export interface EnemyHealthData {
	id: number;
	hp: number;
	maxHp: number;
}

/** An obstacle (barricade/box) placed on the path with an HP pool. */
export interface ObstacleData {
	id: number;
	position: Vector3;
	hp: number;
	/** Whether destroying this box frees trapped soldiers (+squadSize). */
	hasTroops: boolean;
	/** How many troops are freed on destruction. */
	troopReward: number;
}

/** Client -> Server shoot request. */
export interface ShootRequest {
	origin: Vector3;
	direction: Vector3;
}

// ---------------------------------------------------------------------------
// Hero definitions
// ---------------------------------------------------------------------------

export interface HeroDefinition {
	name: string;
	role: HeroRole;
	/** Base attack damage contribution per second. */
	attackDps: number;
	/** Cooldown (seconds) for ultimate ability. */
	ultimateCooldown: number;
	/** Description of the ultimate. */
	ultimateDesc: string;
}

export const HEROES: HeroDefinition[] = [
	{ name: "Shield Guard",   role: HeroRole.Tank,   attackDps: 2,  ultimateCooldown: 20, ultimateDesc: "Energy Shield – absorbs next 10 troop losses" },
	{ name: "Iron Wall",      role: HeroRole.Tank,   attackDps: 3,  ultimateCooldown: 25, ultimateDesc: "Fortify – halves damage taken for 5 s" },
	{ name: "Gatling Ace",    role: HeroRole.Damage, attackDps: 8,  ultimateCooldown: 18, ultimateDesc: "Bullet Storm – triples DPS for 4 s" },
	{ name: "Rocket Commander",role: HeroRole.Damage,attackDps: 10, ultimateCooldown: 30, ultimateDesc: "Missile Barrage – deals 100 dmg to all enemies" },
	{ name: "Helicopter Pilot",role: HeroRole.Damage,attackDps: 12, ultimateCooldown: 35, ultimateDesc: "Airstrike – deals 200 dmg to the boss" },
];

// ---------------------------------------------------------------------------
// Gate generation helpers
// ---------------------------------------------------------------------------

/**
 * Generates a gate pair with one positive and one negative side.
 * Operators are +/- for small squads, x/÷ for later waves.
 */
export function generateGatePair(wave: number, squadSize: number): {
	leftLabel: string; rightLabel: string;
	leftEffect: GateEffect; rightEffect: GateEffect;
} {
	const useMult = wave >= 3 && squadSize >= 20;

	if (useMult) {
		// One multiply side, one divide side
		const mult = math.random(2, 3);
		const div  = math.random(2, 2);
		return {
			leftLabel:   `÷${div}`,
			rightLabel:  `x${mult}`,
			leftEffect:  { type: "multiply", value: 1 / div },
			rightEffect: { type: "multiply", value: mult },
		};
	} else {
		// One add side (positive), one add side (negative)
		const gain = math.random(3, 10);
		const loss = math.random(3, 8);
		return {
			leftLabel:   `-${loss}`,
			rightLabel:  `+${gain}`,
			leftEffect:  { type: "add", value: -loss },
			rightEffect: { type: "add", value: gain },
		};
	}
}

/** Returns true if the positive-side effect is better given current squad size. */
export function betterSide(
	left: GateEffect,
	right: GateEffect,
	squad: number,
): "left" | "right" {
	const applyEffect = (e: GateEffect) =>
		e.type === "add" ? squad + e.value : math.floor(squad * e.value);
	return applyEffect(left) >= applyEffect(right) ? "left" : "right";
}
