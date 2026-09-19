import { randomUUID } from "node:crypto";

export async function askInIsolatedSession(parentSession, prompt, model, timeoutMs = 120_000) {
    const connection = parentSession.connection;
    if (!connection?.sendRequest) throw new Error("Copilot session connection is unavailable.");

    const sessionId = randomUUID();
    const startedAt = Date.now();
    let cursor;
    let lastAssistantMessage;

    try {
        await connection.sendRequest("session.create", {
            sessionId,
            clientName: "budget-lab-assistant",
            model,
            availableTools: ["skill"],
            enableConfigDiscovery: true,
            enableSkills: true,
            requestPermission: false,
            workingDirectory: process.cwd(),
            systemMessage: {
                mode: "append",
                content: "Answer only the embedded Budget Lab question. Do not modify files or state.",
            },
        });
        await connection.sendRequest("session.send", {
            sessionId,
            prompt,
            mode: "immediate",
            agentMode: "interactive",
        });

        while (Date.now() - startedAt < timeoutMs) {
            const remaining = timeoutMs - (Date.now() - startedAt);
            const page = await connection.sendRequest("session.eventLog.read", {
                sessionId,
                cursor,
                max: 200,
                waitMs: Math.min(30_000, Math.max(1, remaining)),
                agentScope: "primary",
            });
            cursor = page.cursor;
            for (const event of page.events) {
                if (event.type === "assistant.message" && event.data.content?.trim()) lastAssistantMessage = event;
                if (event.type === "session.error") throw new Error(event.data.message);
                if (event.type === "session.idle") {
                    if (!lastAssistantMessage) throw new Error("Copilot did not return an answer.");
                    return lastAssistantMessage;
                }
            }
        }
        throw new Error(`Timeout after ${timeoutMs}ms waiting for the Copilot answer.`);
    } finally {
        await connection.sendRequest("session.delete", { sessionId }).catch(() => undefined);
    }
}
