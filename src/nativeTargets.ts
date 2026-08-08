import { randomUUID } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ChatSession } from './types';

const execFile = promisify(execFileCallback);
const ZCODE_RESTORE_PLUGIN_ROOT = ['.zcode', 'cli', 'plugins', 'cache', 'zcode-plugins-official', 'restore-legacy-sessions'];

export interface ZCodeSnapshot {
	readonly meta: {
		readonly taskId: string;
		readonly traceId: string;
		readonly title: string;
		readonly workspacePath: string;
		readonly createdAt: number;
		readonly updatedAt: number;
		readonly migrationSource: 'session-control';
		readonly status: 'completed';
	};
	readonly messages: readonly {
		readonly role: 'user' | 'assistant';
		readonly content: string;
		readonly timestamp: number;
	}[];
}

interface NativeTargetDeps {
	readonly homeDirectory: string;
	readonly createDirectory: (directoryPath: string) => Promise<void>;
	readonly fileExists: (filePath: string) => Promise<boolean>;
	readonly listDirectory: (directoryPath: string) => Promise<string[]>;
	readonly writeFile: (filePath: string, content: string) => Promise<void>;
	readonly runFile: (filePath: string, args: readonly string[]) => Promise<void>;
}

function toTimestamp(value: string, fallback: number): number {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

function normalizeTitle(title: string): string {
	const normalized = title.trim();
	return normalized || 'Untitled Session Control handoff';
}

function defaultDeps(): NativeTargetDeps {
	return {
		homeDirectory: os.homedir(),
		createDirectory: async (directoryPath) => {
			await fs.mkdir(directoryPath, { recursive: true });
		},
		fileExists: async (filePath) => {
			try {
				await fs.access(filePath);
				return true;
			} catch {
				return false;
			}
		},
		listDirectory: async (directoryPath) => fs.readdir(directoryPath),
		writeFile: async (filePath, content) => fs.writeFile(filePath, content, 'utf8'),
		runFile: async (filePath, args) => {
			await execFile(filePath, [...args], { maxBuffer: 10 * 1024 * 1024 });
		},
	};
}

export function createZCodeSnapshot(
	session: ChatSession,
	workspacePath: string,
	traceId: string = randomUUID(),
): ZCodeSnapshot {
	const fallbackTimestamp = toTimestamp(session.savedAt, Date.now());
	const messages = session.turns.map((turn) => ({
		role: turn.type === 'request' ? 'user' as const : 'assistant' as const,
		content: turn.type === 'request' ? turn.prompt : turn.content,
		timestamp: toTimestamp(turn.timestamp, fallbackTimestamp),
	}));
	const createdAt = messages[0]?.timestamp ?? fallbackTimestamp;
	const updatedAt = messages[messages.length - 1]?.timestamp ?? fallbackTimestamp;

	return {
		meta: {
			taskId: `session-control-${session.id}`,
			traceId,
			title: normalizeTitle(session.title),
			workspacePath,
			createdAt,
			updatedAt,
			migrationSource: 'session-control',
			status: 'completed',
		},
		messages,
	};
}

export function buildGrokHandoff(session: ChatSession): string {
	const turns = session.turns.map((turn) => {
		const heading = turn.type === 'request' ? 'User' : 'Assistant';
		const content = turn.type === 'request' ? turn.prompt : turn.content;
		return `## ${heading}\n${content}`;
	});
	const summary = session.markdownSummary.trim();
	return [
		`# Session handoff: ${normalizeTitle(session.title)}`,
		...(summary ? [`## Summary\n${summary}`] : []),
		...turns,
		'## Continuation\nContinue from this context. Do not repeat the transcript; state the next concrete action.',
	].join('\n\n');
}

async function findRestoreScript(deps: NativeTargetDeps): Promise<string> {
	const pluginRoot = path.join(deps.homeDirectory, ...ZCODE_RESTORE_PLUGIN_ROOT);
	const versions = await deps.listDirectory(pluginRoot);
	for (const version of versions.sort().reverse()) {
		const candidate = path.join(pluginRoot, version, 'skills', 'restore-legacy-sessions', 'scripts', 'restore-conversation.mjs');
		if (await deps.fileExists(candidate)) {
			return candidate;
		}
	}
	throw new Error(`Could not find a ZCode restore-legacy-sessions plugin under ${pluginRoot}.`);
}

export async function portSessionToZCode(
	session: ChatSession,
	workspacePath: string,
	overrides: Partial<NativeTargetDeps> = {},
): Promise<string> {
	const deps = { ...defaultDeps(), ...overrides };
	const snapshot = createZCodeSnapshot(session, workspacePath);
	const snapshotDirectory = path.join(deps.homeDirectory, '.zcode', 'v2', 'sessions', 'session-control');
	const snapshotPath = path.join(snapshotDirectory, `${snapshot.meta.taskId}.json`);
	await deps.createDirectory(snapshotDirectory);
	await deps.writeFile(snapshotPath, JSON.stringify(snapshot, null, 2));
	const restoreScript = await findRestoreScript(deps);
	await deps.runFile(process.execPath, [restoreScript, '--snapshot', snapshotPath]);
	return snapshotPath;
}

export async function sendSessionToGrok(
	session: ChatSession,
	grokSessionId: string,
	drewChannelPath = 'drew-channel',
	overrides: Partial<NativeTargetDeps> = {},
): Promise<void> {
	const sessionId = grokSessionId.trim();
	if (!sessionId) {
		throw new Error('A Grok Drew session ID is required.');
	}
	const deps = { ...defaultDeps(), ...overrides };
	await deps.runFile(drewChannelPath, ['send', '--session', sessionId, '--body', buildGrokHandoff(session)]);
}
