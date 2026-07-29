import { randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
	createHttpHooks,
	ReadonlyProvider,
	RealFSProvider,
	type SecretDefinition,
	type VirtualProvider,
	VM,
} from "@earendil-works/gondolin";

import type { ResolvedConversation, ResolvedGondolinMount } from "./core/config-types.js";
import { ensureConversationDirs } from "./log.js";

export const GONDOLIN_WORKSPACE = "/workspace";
export const GONDOLIN_SHARED = "/shared";

function toPosix(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

function isInside(root: string, value: string): boolean {
	const rel = path.relative(root, value);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stripRegeneratedContentLength(request: Request): Request {
	if (!request.headers.has("content-length")) return request;
	const headers = new Headers(request.headers);
	headers.delete("content-length");
	return new Request(request, { headers });
}

function resolveSecretEnvironment(conversation: ResolvedConversation): {
	env?: Record<string, string>;
	httpHooks?: ReturnType<typeof createHttpHooks>["httpHooks"];
	configuredSecretNames: string[];
} {
	const configuredSecretNames = Object.keys(conversation.gondolinSecrets);
	const secrets: Record<string, SecretDefinition> = {};
	for (const [name, secret] of Object.entries(conversation.gondolinSecrets)) {
		if (!secret.value.trim()) throw new Error(`Gondolin secret ${name} must have a value`);
		if (secret.hosts.length === 0) throw new Error(`Gondolin secret ${name} must declare at least one host`);
		secrets[name] = { hosts: [...secret.hosts], value: secret.value };
	}
	const { env, httpHooks } = createHttpHooks({
		allowedHosts: ["*"],
		secrets,
		onRequest: stripRegeneratedContentLength,
	});
	return {
		env: Object.keys(env).length > 0 ? env : undefined,
		httpHooks,
		configuredSecretNames,
	};
}

async function walk(
	root: string,
	current: string,
	visit: (absolutePath: string, relativePath: string) => Promise<boolean>,
): Promise<void> {
	const entries = await readdir(current, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name === ".git" || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
		const absolutePath = path.join(current, entry.name);
		const relativePath = toPosix(path.relative(root, absolutePath));
		const shouldDescend = await visit(absolutePath, relativePath);
		if (shouldDescend && entry.isDirectory()) await walk(root, absolutePath, visit);
	}
}

export class ConversationSandbox {
	readonly conversation: ResolvedConversation;
	private vm: VM | undefined;
	private starting: Promise<VM> | undefined;

	constructor(conversation: ResolvedConversation) {
		this.conversation = conversation;
	}

	async start(): Promise<VM> {
		if (this.vm) return this.vm;
		if (this.starting) return this.starting;
		this.starting = (async () => {
			await ensureConversationDirs(this.conversation);
			const secretConfig = resolveSecretEnvironment(this.conversation);
			const mounts: Record<string, VirtualProvider> = {
				[GONDOLIN_WORKSPACE]: new RealFSProvider(this.conversation.workspaceDir),
				[GONDOLIN_SHARED]: new RealFSProvider(this.conversation.sharedDir),
			};
			for (const mount of this.conversation.gondolinMounts) {
				const hostStats = await stat(mount.hostPath).catch(() => undefined);
				if (!hostStats?.isDirectory())
					throw new Error(`Gondolin mount host path is not a directory: ${mount.hostPath} (${mount.guestPath})`);
				const provider: VirtualProvider = new RealFSProvider(mount.hostPath);
				mounts[mount.guestPath] = mount.readOnly ? new ReadonlyProvider(provider) : provider;
			}
			const vm = await VM.create({
				sessionLabel: `pi-chat ${this.conversation.conversationName}`,
				env: secretConfig.env,
				httpHooks: secretConfig.httpHooks,
				vfs: { mounts },
			});
			await vm.exec("command -v bash > /dev/null 2>&1 || apk add --no-cache bash > /dev/null 2>&1 || true");
			this.vm = vm;
			this.starting = undefined;
			await writeFile(
				path.join(this.conversation.gondolinDir, "session.json"),
				`${JSON.stringify(
					{
						vmId: vm.id,
						secretNames: secretConfig.configuredSecretNames,
						mounts: this.conversation.gondolinMounts,
					},
					null,
					"\t",
				)}\n`,
				"utf8",
			);
			return vm;
		})();
		return this.starting;
	}

	async close(): Promise<void> {
		const vm = this.vm;
		this.vm = undefined;
		this.starting = undefined;
		if (vm) await vm.close();
	}

	private mountRoots(): ResolvedGondolinMount[] {
		return [
			{ guestPath: GONDOLIN_WORKSPACE, hostPath: this.conversation.workspaceDir, readOnly: false },
			{ guestPath: GONDOLIN_SHARED, hostPath: this.conversation.sharedDir, readOnly: false },
			...this.conversation.gondolinMounts,
		];
	}

	private resolvedMountRoots(): Array<ResolvedGondolinMount & { resolvedHostPath: string }> {
		return this.mountRoots()
			.map((mount) => ({ ...mount, resolvedHostPath: realpathSync(mount.hostPath) }))
			.sort((a, b) => b.resolvedHostPath.length - a.resolvedHostPath.length);
	}

	private findMountForGuestPath(guestPath: string): ResolvedGondolinMount | undefined {
		return this.mountRoots().find(
			(mount) => guestPath === mount.guestPath || guestPath.startsWith(`${mount.guestPath}/`),
		);
	}

	private resolveGuestPath(inputPath: string): string {
		const trimmed = inputPath.trim();
		if (!trimmed) throw new Error("Path must not be empty");
		const base = trimmed.startsWith("/") ? "/" : GONDOLIN_WORKSPACE;
		const guestPath = path.posix.resolve(base, trimmed);
		if (!this.findMountForGuestPath(guestPath)) throw new Error(`Path is outside mounted storage: ${inputPath}`);
		return guestPath;
	}

	private resolveWritableGuestPath(inputPath: string): string {
		const guestPath = this.resolveGuestPath(inputPath);
		const mount = this.findMountForGuestPath(guestPath);
		if (mount?.readOnly) throw new Error(`Path is on a read-only mount (${mount.guestPath}): ${inputPath}`);
		return guestPath;
	}

	async stageAttachment(inputPath: string): Promise<string> {
		const sourcePath = this.guestToHostPath(inputPath);
		const handle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
		try {
			const fileStats = await handle.stat();
			if (!fileStats.isFile()) throw new Error(`Not a file: ${inputPath}`);
			const stagingDir = path.join(this.conversation.gondolinDir, "outgoing");
			await mkdir(stagingDir, { recursive: true });
			const safeName = path.basename(sourcePath).replace(/[^a-zA-Z0-9._-]+/g, "_") || "attachment";
			const stagedPath = path.join(stagingDir, `${Date.now()}-${randomUUID()}-${safeName}`);
			await writeFile(stagedPath, await handle.readFile(), { flag: "wx" });
			return stagedPath;
		} finally {
			await handle.close();
		}
	}

	resolveToolPath(inputPath: string): string {
		return this.resolveGuestPath(inputPath);
	}

	guestToHostPath(inputPath: string): string {
		const guestPath = this.resolveGuestPath(inputPath);
		const mount = this.findMountForGuestPath(guestPath);
		if (!mount) throw new Error(`Path is outside mounted storage: ${inputPath}`);
		const relativePath = path.posix.relative(mount.guestPath, guestPath);
		const hostPath = path.join(mount.hostPath, ...relativePath.split("/").filter(Boolean));
		const resolvedRoot = realpathSync(mount.hostPath);
		const resolvedHostPath = realpathSync(hostPath);
		if (!isInside(resolvedRoot, resolvedHostPath)) throw new Error(`Path is outside mounted storage: ${inputPath}`);
		return resolvedHostPath;
	}

	private assertMountedHostPath(hostPath: string): string {
		const resolved = realpathSync(hostPath);
		for (const mount of this.resolvedMountRoots()) {
			if (isInside(mount.resolvedHostPath, resolved)) return resolved;
		}
		throw new Error(`Path is outside mounted storage: ${hostPath}`);
	}

	hostToGuestPath(hostPath: string): string {
		const resolved = this.assertMountedHostPath(hostPath);
		for (const mount of this.resolvedMountRoots()) {
			if (!isInside(mount.resolvedHostPath, resolved)) continue;
			const relativePath = toPosix(path.relative(mount.resolvedHostPath, resolved));
			return relativePath ? path.posix.join(mount.guestPath, relativePath) : mount.guestPath;
		}
		throw new Error(`Path is outside mounted storage: ${hostPath}`);
	}

	async createReadOperations() {
		const vm = await this.start();
		return {
			readFile: async (guestPath: string) => {
				const resolvedPath = this.resolveGuestPath(guestPath);
				return vm.fs.readFile(resolvedPath);
			},
			access: async (guestPath: string) => {
				const resolvedPath = this.resolveGuestPath(guestPath);
				await vm.fs.access(resolvedPath);
			},
			detectImageMimeType: async (guestPath: string) => {
				const ext = path.posix.extname(this.resolveGuestPath(guestPath)).toLowerCase();
				if (ext === ".png") return "image/png";
				if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
				if (ext === ".gif") return "image/gif";
				if (ext === ".webp") return "image/webp";
				return null;
			},
		};
	}

	async createWriteOperations() {
		const vm = await this.start();
		return {
			writeFile: async (guestPath: string, content: string) => {
				const resolvedPath = this.resolveWritableGuestPath(guestPath);
				await vm.fs.writeFile(resolvedPath, content);
			},
			mkdir: async (guestPath: string) => {
				const resolvedPath = this.resolveWritableGuestPath(guestPath);
				await vm.fs.mkdir(resolvedPath, { recursive: true });
			},
		};
	}

	async createEditOperations() {
		const vm = await this.start();
		return {
			readFile: async (guestPath: string) => {
				const resolvedPath = this.resolveGuestPath(guestPath);
				return vm.fs.readFile(resolvedPath);
			},
			writeFile: async (guestPath: string, content: string) => {
				const resolvedPath = this.resolveWritableGuestPath(guestPath);
				await vm.fs.writeFile(resolvedPath, content);
			},
			access: async (guestPath: string) => {
				const resolvedPath = this.resolveGuestPath(guestPath);
				await vm.fs.access(resolvedPath);
			},
		};
	}

	async createLsOperations() {
		const vm = await this.start();
		return {
			exists: async (guestPath: string) => {
				try {
					const resolvedPath = this.resolveGuestPath(guestPath);
					await vm.fs.access(resolvedPath);
					return true;
				} catch {
					return false;
				}
			},
			stat: async (guestPath: string) => {
				const resolvedPath = this.resolveGuestPath(guestPath);
				return vm.fs.stat(resolvedPath);
			},
			readdir: async (guestPath: string) => {
				const resolvedPath = this.resolveGuestPath(guestPath);
				return vm.fs.listDir(resolvedPath);
			},
		};
	}

	async createFindOperations() {
		return {
			exists: async (guestPath: string) => {
				try {
					await access(this.guestToHostPath(guestPath));
					return true;
				} catch {
					return false;
				}
			},
			glob: async (pattern: string, guestCwd: string, options: { ignore: string[]; limit: number }) => {
				const rootHostPath = this.guestToHostPath(guestCwd);
				const results: string[] = [];
				await walk(rootHostPath, rootHostPath, async (absolutePath, relativePath) => {
					if (results.length >= options.limit) return false;
					const entryStat = await stat(absolutePath);
					if (entryStat.isDirectory()) return true;
					const basename = path.posix.basename(relativePath);
					const matches = pattern.includes("/")
						? path.matchesGlob(relativePath, pattern)
						: path.matchesGlob(basename, pattern);
					if (matches) results.push(this.hostToGuestPath(absolutePath));
					return false;
				});
				return results;
			},
		};
	}

	async createGrepOperations() {
		return {
			isDirectory: async (hostPath: string) => (await stat(this.assertMountedHostPath(hostPath))).isDirectory(),
			readFile: async (hostPath: string) => readFile(this.assertMountedHostPath(hostPath), "utf8"),
		};
	}

	async createBashOperations() {
		const vm = await this.start();
		return {
			exec: async (
				command: string,
				cwd: string,
				options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
			) => {
				const guestCwd = this.resolveGuestPath(cwd);
				const controller = new AbortController();
				const onAbort = () => controller.abort();
				options.signal?.addEventListener("abort", onAbort, { once: true });
				let timedOut = false;
				const timer =
					options.timeout && options.timeout > 0
						? setTimeout(() => {
								timedOut = true;
								controller.abort();
							}, options.timeout * 1000)
						: undefined;
				try {
					const proc = vm.exec(["/bin/bash", "-lc", command], {
						cwd: guestCwd,
						signal: controller.signal,
						stdout: "pipe",
						stderr: "pipe",
					});
					for await (const chunk of proc.output()) options.onData(chunk.data);
					const result = await proc;
					return { exitCode: result.exitCode };
				} catch (error) {
					if (options.signal?.aborted) throw new Error("aborted");
					if (timedOut) throw new Error(`timeout:${options.timeout}`);
					throw error;
				} finally {
					if (timer) clearTimeout(timer);
					options.signal?.removeEventListener("abort", onAbort);
				}
			},
		};
	}
}
