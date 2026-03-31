/**
 * shared/types.ts
 * Shared type definitions and interfaces used by both server and client.
 */

// ---------------------------------------------------------------------------
// Game constants
// ---------------------------------------------------------------------------

/** Total number of path tiles stretching away from the player spawn. */
export const PATH_LENGTH = 60;

/** Y coordinate of the ground/floor surface. */
export const FLOOR_Y = 0;

/** Width of the bridge/path in studs. */
export const PATH_WIDTH = 10;

/** Height of each path tile (thickness of the floor). */
export const TILE_HEIGHT = 1;

/** How far apart gate pairs are spaced along the path. */
export const GATE_SPACING = 20;

/** Projectile travel speed in studs per second. */
export const PROJECTILE_SPEED = 80;

/** Radius used for projectile hit-detection sphere casts. */
export const PROJECTILE_HIT_RADIUS = 1.2;

/** How many seconds between wave spawns. */
export const WAVE_INTERVAL = 8;

/** Base enemy count for wave 1; scales with wave number. */
export const BASE_ENEMIES_PER_WAVE = 5;

/** Enemy walk speed in studs per second. */
export const ENEMY_SPEED = 6;

/** Enemy health points (base). */
export const ENEMY_BASE_HP = 3;

/** How many lives the player starts with. */
export const STARTING_LIVES = 3;

/** Score awarded for each enemy kill. */
export const SCORE_PER_KILL = 10;

/** Score bonus awarded for completing a wave. */
export const WAVE_COMPLETION_BONUS = 50;

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

/** Identifies which side of a gate the player walked through. */
export const enum GateSide {
	Left = "Left",
	Right = "Right",
}

/** Runtime state of the overall game session. */
export const enum GameState {
	Lobby = "Lobby",
	Playing = "Playing",
	WaveComplete = "WaveComplete",
	GameOver = "GameOver",
}

// ---------------------------------------------------------------------------
// Data interfaces
// ---------------------------------------------------------------------------

/** Snapshot of the current session sent to all clients. */
export interface GameStateData {
	state: GameState;
	wave: number;
	score: number;
	lives: number;
	multiplier: number;
}

/** Describes a gate object placed along the path. */
export interface GateData {
	/** Unique id for this gate instance. */
	id: number;
	/** Distance from player spawn along the path. */
	position: number;
	/** Label shown on the left post (e.g. "+1"). */
	leftLabel: string;
	/** Label shown on the right post (e.g. "x2"). */
	rightLabel: string;
	/** Effect applied when walking through the left post. */
	leftEffect: GateEffect;
	/** Effect applied when walking through the right post. */
	rightEffect: GateEffect;
}

/** Effect that a gate post applies to the score multiplier or lives. */
export interface GateEffect {
	/** "add" increments the multiplier; "multiply" scales it; "life" grants extra life. */
	type: "add" | "multiply" | "life";
	value: number;
}

/** Minimal data the client needs to render a spawned enemy. */
export interface EnemySpawnData {
	/** Server-assigned unique id. */
	id: number;
	/** World-space spawn position. */
	position: Vector3;
	/** Maximum HP (used to render health bar proportionally). */
	maxHp: number;
}

/** Fired whenever an enemy's HP changes. */
export interface EnemyHealthData {
	id: number;
	hp: number;
	maxHp: number;
}

/** Payload sent from client to server when firing a shot. */
export interface ShootRequest {
	/** Ray origin in world space (camera / gun position). */
	origin: Vector3;
	/** Unit direction vector. */
	direction: Vector3;
}

// ---------------------------------------------------------------------------
// Additional gate effect helpers (negative gates like -8 shown in screenshots)
// ---------------------------------------------------------------------------

/**
 * Returns a random gate pair: one positive, one negative side.
 * Mirrors the "-8 / +5" style gates seen in the reference screenshots.
 */
export function randomGatePair(): { leftLabel: string; rightLabel: string; leftEffect: GateEffect; rightEffect: GateEffect } {
	const addVal  = math.random(1, 5);
	const loseVal = math.random(2, 8);
	return {
		leftLabel:   `-${loseVal}`,
		rightLabel:  `+${addVal}`,
		leftEffect:  { type: "add", value: -loseVal },
		rightEffect: { type: "add", value: addVal },
	};
}
