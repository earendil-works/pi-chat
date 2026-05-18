import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");

const finalHandler = source.slice(source.lastIndexOf("const finalText = summary.text"));
const persistIndex = finalHandler.indexOf("await runtime.completeActiveJob(finalText, undefined, attachmentPaths);");
const sendIndex = finalHandler.indexOf("liveConnection.send(finalText, attachmentPaths");
const catchIndex = finalHandler.indexOf("await runtime.appendError(`send failed after output was persisted:");
const failAfterPersistIndex = finalHandler.indexOf("await runtime.failActiveJob", persistIndex);

assert.notEqual(persistIndex, -1, "final output is persisted before attempting delivery");
assert.notEqual(sendIndex, -1, "final output is still delivered to the live chat connection");
assert.ok(persistIndex < sendIndex, "persistence must happen before live send so send failure cannot lose output");
assert.notEqual(catchIndex, -1, "send failures are recorded as errors after persistence");
assert.ok(
	failAfterPersistIndex === -1 || failAfterPersistIndex > finalHandler.indexOf("});"),
	"send failures must not replace persisted output with job_failed",
);

console.log("optimistic persistence behavior is covered");
