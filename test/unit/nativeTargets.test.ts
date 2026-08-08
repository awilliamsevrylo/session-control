import * as assert from 'node:assert';
import {
	buildGrokHandoff,
	createZCodeSnapshot,
	portSessionToZCode,
	sendSessionToGrok,
} from '../../src/nativeTargets';
import type { ChatSession } from '../../src/types';

function createSession(): ChatSession {
	return {
		version: 1,
		id: 'session-1',
		title: 'Investigate import',
		savedAt: '2026-08-08T12:00:00.000Z',
		git: null,
		vscodeVersion: '1.132.0',
		totalTurns: 2,
		part: null,
		totalParts: null,
		previousPartFile: null,
		nextPartFile: null,
		markdownSummary: 'Investigated the source layout.',
		turns: [
			{
				type: 'request',
				participant: 'user',
				prompt: 'Where is the session?',
				references: [],
				timestamp: '2026-08-08T12:00:00.000Z',
			},
			{
				type: 'response',
				participant: 'assistant',
				content: 'It is stored locally.',
				toolCalls: [],
				timestamp: '2026-08-08T12:01:00.000Z',
			},
		],
	};
}

suite('nativeTargets', () => {
	test('converts a saved session into the ZCode legacy snapshot contract', () => {
		const snapshot = createZCodeSnapshot(createSession(), '/work/project', 'trace-1');

		assert.deepEqual(snapshot.meta, {
			taskId: 'session-control-session-1',
			traceId: 'trace-1',
			title: 'Investigate import',
			workspacePath: '/work/project',
			createdAt: Date.parse('2026-08-08T12:00:00.000Z'),
			updatedAt: Date.parse('2026-08-08T12:01:00.000Z'),
			migrationSource: 'session-control',
			status: 'completed',
		});
		assert.deepEqual(snapshot.messages, [
			{ role: 'user', content: 'Where is the session?', timestamp: Date.parse('2026-08-08T12:00:00.000Z') },
			{ role: 'assistant', content: 'It is stored locally.', timestamp: Date.parse('2026-08-08T12:01:00.000Z') },
		]);
	});

	test('builds a Grok handoff that preserves title, summary, and turn order', () => {
		const handoff = buildGrokHandoff(createSession());

		assert.match(handoff, /# Session handoff: Investigate import/);
		assert.match(handoff, /## Summary\nInvestigated the source layout\./);
		assert.match(handoff, /## User\nWhere is the session\?/);
		assert.match(handoff, /## Assistant\nIt is stored locally\./);
	});

	test('writes a ZCode snapshot and invokes the official restore script', async () => {
		const writes: { path: string; content: string }[] = [];
		const commands: { filePath: string; args: readonly string[] }[] = [];
		const snapshotPath = await portSessionToZCode(createSession(), '/work/project', {
			homeDirectory: '/home/tester',
			createDirectory: async () => undefined,
			fileExists: async () => true,
			listDirectory: async () => ['0.1.1'],
			writeFile: async (filePath, content) => {
				writes.push({ path: filePath, content });
			},
			runFile: async (filePath, args) => {
				commands.push({ filePath, args });
			},
		});

		assert.equal(snapshotPath, '/home/tester/.zcode/v2/sessions/session-control/session-control-session-1.json');
		assert.equal(writes.length, 1);
		assert.match(writes[0]?.content ?? '', /"migrationSource": "session-control"/);
		assert.deepEqual(commands, [{
			filePath: process.execPath,
			args: [
				'/home/tester/.zcode/cli/plugins/cache/zcode-plugins-official/restore-legacy-sessions/0.1.1/skills/restore-legacy-sessions/scripts/restore-conversation.mjs',
				'--snapshot',
				snapshotPath,
			],
		}]);
	});

	test('sends the full handoff to the configured Drew session', async () => {
		const commands: { filePath: string; args: readonly string[] }[] = [];
		await sendSessionToGrok(createSession(), 'grok-session', '/usr/local/bin/drew-channel', {
			runFile: async (filePath, args) => {
				commands.push({ filePath, args });
			},
		});

		assert.equal(commands[0]?.filePath, '/usr/local/bin/drew-channel');
		assert.deepEqual(commands[0]?.args.slice(0, 3), ['send', '--session', 'grok-session']);
		assert.match(commands[0]?.args[4] ?? '', /# Session handoff: Investigate import/);
	});
});
