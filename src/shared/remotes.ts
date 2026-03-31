/**
 * shared/remotes.ts
 * Central RemoteEvent / RemoteFunction definitions.
 */

import { RunService, ReplicatedStorage } from "@rbxts/services";
import type {
	EnemyHealthData,
	EnemySpawnData,
	GameStateData,
	ShootRequest,
	ObstacleData,
} from "./types";

const IS_SERVER = RunService.IsServer();

function getRemotesFolder(): Folder {
	let folder = ReplicatedStorage.FindFirstChild("Remotes") as Folder | undefined;
	if (!folder) {
		if (IS_SERVER) {
			folder = new Instance("Folder");
			folder.Name = "Remotes";
			folder.Parent = ReplicatedStorage;
		} else {
			folder = ReplicatedStorage.WaitForChild("Remotes", 10) as Folder;
		}
	}
	return folder!;
}

function getRemote(name: string): RemoteEvent {
	const folder = getRemotesFolder();
	if (IS_SERVER) {
		let r = folder.FindFirstChild(name) as RemoteEvent | undefined;
		if (!r) { r = new Instance("RemoteEvent"); r.Name = name; r.Parent = folder; }
		return r;
	}
	return folder.WaitForChild(name, 10) as RemoteEvent;
}

function getFunction(name: string): RemoteFunction {
	const folder = getRemotesFolder();
	if (IS_SERVER) {
		let f = folder.FindFirstChild(name) as RemoteFunction | undefined;
		if (!f) { f = new Instance("RemoteFunction"); f.Name = name; f.Parent = folder; }
		return f;
	}
	return folder.WaitForChild(name, 10) as RemoteFunction;
}

// Server → All Clients
export const getGameStateRemote   = () => getRemote("GameState")         as RemoteEvent<(d: GameStateData) => void>;
export const getEnemySpawnedRemote= () => getRemote("EnemySpawned")      as RemoteEvent<(d: EnemySpawnData) => void>;
export const getEnemyHealthRemote = () => getRemote("EnemyHealth")       as RemoteEvent<(d: EnemyHealthData) => void>;
export const getEnemyReachedEndRemote = () => getRemote("EnemyReachedEnd") as RemoteEvent<(id: number) => void>;
export const getObstacleSpawnRemote   = () => getRemote("ObstacleSpawn")   as RemoteEvent<(d: ObstacleData) => void>;
export const getObstacleHealthRemote  = () => getRemote("ObstacleHealth")  as RemoteEvent<(d: EnemyHealthData) => void>;
export const getHeroUltimateRemote    = () => getRemote("HeroUltimate")    as RemoteEvent<(heroIndex: number, ult: string) => void>;

// Client → Server
export const getShootRemote       = () => getRemote("Shoot")             as RemoteEvent<(r: ShootRequest) => void>;
export const getGateTriggerRemote = () => getRemote("GateTrigger")       as RemoteEvent<(gateId: number, side: string) => void>;

// Client → Server (invoke)
export const getRequestStateFunction = () => getFunction("RequestState");
