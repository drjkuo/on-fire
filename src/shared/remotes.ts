/**
 * shared/remotes.ts
 * Central definitions for all RemoteEvents and RemoteFunctions.
 *
 * Pattern: both server and client import this module and call getRemote() /
 * getFunction() which lazily create or fetch the Instance from
 * ReplicatedStorage.Remotes.  This avoids any race between server creation and
 * client access – the server always creates them before any LocalScript runs.
 */

import { RunService, ReplicatedStorage } from "@rbxts/services";
import type {
	EnemyHealthData,
	EnemySpawnData,
	GameStateData,
	ShootRequest,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const IS_SERVER = RunService.IsServer();

/** Lazily resolves the Remotes folder, creating it on the server if absent. */
function getRemotesFolder(): Folder {
	let folder = ReplicatedStorage.FindFirstChild("Remotes") as Folder | undefined;
	if (!folder) {
		if (IS_SERVER) {
			folder = new Instance("Folder");
			folder.Name = "Remotes";
			folder.Parent = ReplicatedStorage;
		} else {
			// Client: wait up to 10 s for the server to create it.
			folder = ReplicatedStorage.WaitForChild("Remotes", 10) as Folder;
		}
	}
	return folder!;
}

/**
 * Returns a RemoteEvent with the given name, creating it on the server
 * or waiting for it on the client.
 */
function getRemote(name: string): RemoteEvent {
	const folder = getRemotesFolder();
	if (IS_SERVER) {
		let remote = folder.FindFirstChild(name) as RemoteEvent | undefined;
		if (!remote) {
			remote = new Instance("RemoteEvent");
			remote.Name = name;
			remote.Parent = folder;
		}
		return remote;
	} else {
		return folder.WaitForChild(name, 10) as RemoteEvent;
	}
}

/**
 * Returns a RemoteFunction with the given name, creating it on the server
 * or waiting for it on the client.
 */
function getFunction(name: string): RemoteFunction {
	const folder = getRemotesFolder();
	if (IS_SERVER) {
		let fn = folder.FindFirstChild(name) as RemoteFunction | undefined;
		if (!fn) {
			fn = new Instance("RemoteFunction");
			fn.Name = name;
			fn.Parent = folder;
		}
		return fn;
	} else {
		return folder.WaitForChild(name, 10) as RemoteFunction;
	}
}

// ---------------------------------------------------------------------------
// Public remote accessors
// ---------------------------------------------------------------------------

/**
 * Server -> All Clients: full game-state snapshot (wave, score, lives, etc.).
 * Fired whenever any of those values change.
 */
export function getGameStateRemote(): RemoteEvent<(data: GameStateData) => void> {
	return getRemote("GameState") as RemoteEvent<(data: GameStateData) => void>;
}

/**
 * Server -> All Clients: an enemy has spawned.
 * Clients use this to create a visual enemy model at the given position.
 */
export function getEnemySpawnedRemote(): RemoteEvent<(data: EnemySpawnData) => void> {
	return getRemote("EnemySpawned") as RemoteEvent<(data: EnemySpawnData) => void>;
}

/**
 * Server -> All Clients: an enemy's health changed (or it died when hp === 0).
 */
export function getEnemyHealthRemote(): RemoteEvent<(data: EnemyHealthData) => void> {
	return getRemote("EnemyHealth") as RemoteEvent<(data: EnemyHealthData) => void>;
}

/**
 * Server -> All Clients: an enemy reached the player end of the path.
 * Clients play a hit-flash and the server deducts a life.
 */
export function getEnemyReachedEndRemote(): RemoteEvent<(enemyId: number) => void> {
	return getRemote("EnemyReachedEnd") as RemoteEvent<(enemyId: number) => void>;
}

/**
 * Client -> Server: player fired a shot.
 * Server validates, performs ray/sphere cast hit detection, and broadcasts
 * results via EnemyHealth.
 */
export function getShootRemote(): RemoteEvent<(request: ShootRequest) => void> {
	return getRemote("Shoot") as RemoteEvent<(request: ShootRequest) => void>;
}

/**
 * Client -> Server: player walked through a gate post.
 * Server applies the gate's effect and broadcasts updated GameState.
 */
export function getGateTriggerRemote(): RemoteEvent<(gateId: number, side: string) => void> {
	return getRemote("GateTrigger") as RemoteEvent<(gateId: number, side: string) => void>;
}

/**
 * Client -> Server (RemoteFunction): request current GameState snapshot.
 * Used on initial load so the client doesn't have to wait for the next
 * broadcast event.
 */
export function getRequestStateFunction(): RemoteFunction {
	return getFunction("RequestState");
}
