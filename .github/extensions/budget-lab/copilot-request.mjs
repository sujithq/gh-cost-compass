export async function sendAndWaitForTurn(session, options, timeoutMs = 120_000) {
    const userTurns = new Map();
    const assistantMessages = new Map();
    const completedTurns = new Set();
    let expectedMessageId;
    let expectedTurnId;
    let resolveOutcome;
    let rejectOutcome;

    const outcome = new Promise((resolve, reject) => {
        resolveOutcome = resolve;
        rejectOutcome = reject;
    });

    const finishCompletedTurn = () => {
        if (!expectedTurnId || !completedTurns.has(expectedTurnId)) return;
        const response = assistantMessages.get(expectedTurnId);
        const text = response?.data?.content?.trim();
        if (!text) rejectOutcome(new Error("Copilot did not return an answer."));
        else resolveOutcome(response);
    };

    const unsubscribe = session.on((event) => {
        if (event.type === "user.message" && event.data.messageId && event.data.turnId) {
            userTurns.set(event.data.messageId, event.data.turnId);
            if (event.data.messageId === expectedMessageId) {
                expectedTurnId = event.data.turnId;
                finishCompletedTurn();
            }
            return;
        }
        if (!event.agentId && event.type === "assistant.message" && event.data.turnId) {
            assistantMessages.set(event.data.turnId, event);
            return;
        }
        if (!event.agentId && event.type === "assistant.turn_end") {
            completedTurns.add(event.data.turnId);
            finishCompletedTurn();
            return;
        }
        if (event.type === "session.error") {
            rejectOutcome(new Error(event.data.message));
        }
    });

    const timeout = setTimeout(() => {
        rejectOutcome(new Error(`Timeout after ${timeoutMs}ms waiting for the Copilot turn to complete.`));
    }, timeoutMs);

    try {
        expectedMessageId = await session.send(options);
        expectedTurnId = userTurns.get(expectedMessageId);
        finishCompletedTurn();
        return await outcome;
    } finally {
        clearTimeout(timeout);
        unsubscribe();
    }
}
