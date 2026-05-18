import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

export interface PendingSecretRequest {
	name: string;
	privateKeyPem: string;
}

const pendingSecrets = new Map<string, PendingSecretRequest>();

function pendingSecretPath(storageDir: string, requestId: string): string {
	return join(storageDir, "pending-secrets", `${encodeURIComponent(requestId)}.json`);
}

export async function persistPendingSecretRequest(storageDir: string, requestId: string): Promise<void> {
	const pending = pendingSecrets.get(requestId);
	if (!pending) throw new Error(`Unknown pending secret request: ${requestId}`);
	await mkdir(join(storageDir, "pending-secrets"), { recursive: true });
	await writeFile(pendingSecretPath(storageDir, requestId), JSON.stringify(pending), { encoding: "utf8", mode: 0o600 });
}

async function loadPendingSecretRequest(
	storageDir: string | undefined,
	requestId: string,
): Promise<PendingSecretRequest | undefined> {
	const cached = pendingSecrets.get(requestId);
	if (cached) return cached;
	if (!storageDir) return undefined;
	try {
		const pending = JSON.parse(
			await readFile(pendingSecretPath(storageDir, requestId), "utf8"),
		) as PendingSecretRequest;
		pendingSecrets.set(requestId, pending);
		return pending;
	} catch {
		return undefined;
	}
}

async function forgetPendingSecretRequest(storageDir: string | undefined, requestId: string): Promise<void> {
	pendingSecrets.delete(requestId);
	if (storageDir) await rm(pendingSecretPath(storageDir, requestId), { force: true });
}

export function isValidSecretName(name: string): boolean {
	return SECRET_NAME_PATTERN.test(name) && name !== "." && name !== "..";
}

export function createSecretRequest(name: string, description: string): { requestId: string; widgetUrl: string } {
	if (!isValidSecretName(name)) {
		throw new Error("Secret name may only contain letters, numbers, dots, underscores, and dashes");
	}
	const { publicKey, privateKey } = generateKeyPairSync("rsa", {
		modulusLength: 2048,
		publicKeyEncoding: { type: "spki", format: "der" },
		privateKeyEncoding: { type: "pkcs8", format: "pem" },
	});
	const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	pendingSecrets.set(requestId, { name, privateKeyPem: privateKey as string });
	const pubB64 = (publicKey as Buffer).toString("base64");
	const hash = Buffer.from(JSON.stringify({ n: name, d: description, k: pubB64, r: requestId })).toString("base64");
	return { requestId, widgetUrl: `https://pi.dev/secret#${hash}` };
}

export function decryptSecretPayload(payload: string, privateKeyPem: string): string {
	const buf = Buffer.from(payload.replace(/\s+/g, ""), "base64");
	if (buf.length < 2) throw new Error("Secret payload is too short");
	const kl = buf.readUInt16BE(0);
	if (kl <= 0 || buf.length < 2 + kl + 12 + 16) throw new Error("Secret payload is malformed");
	const ek = buf.subarray(2, 2 + kl);
	const r = buf.subarray(2 + kl);
	const iv = r.subarray(0, 12);
	const tag = r.subarray(r.length - 16);
	const ct = r.subarray(12, r.length - 16);
	const aes = privateDecrypt({ key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, ek);
	const d = createDecipheriv("aes-256-gcm", aes, iv);
	d.setAuthTag(tag);
	return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

export async function tryDecryptSecret(
	text: string,
	storageDir?: string,
): Promise<{ requestId: string; name: string; decrypted: string } | undefined> {
	const match = text.match(/!secret:([^\s:]+):([A-Za-z0-9+/=\s]+)/);
	if (!match) return undefined;
	const [, requestId, payload] = match;
	const pending = await loadPendingSecretRequest(storageDir, requestId);
	if (!pending) return undefined;
	try {
		const decrypted = decryptSecretPayload(payload, pending.privateKeyPem);
		await forgetPendingSecretRequest(storageDir, requestId);
		return { requestId, name: pending.name, decrypted };
	} catch {
		return undefined;
	}
}
