/** Pure message helpers and an in-memory, session-scoped reader for Pocket. */

export function previewText(message, limit = 180) {
    if (!Number.isInteger(limit) || limit < 1) {
        throw new RangeError("Preview length must be a positive integer.");
    }

    const text = String(message.text ?? "").replace(/\s+/gu, " ").trim();

    if (!text) {
        return "Attachment or empty message";
    }

    const characters = Array.from(text);

    return characters.length > limit || message.clipped
        ? `${characters.slice(0, limit - 1).join("")}…`
        : text;
}

export function filterMessages(messages, query) {
    const words = String(query ?? "").normalize("NFKC").toLowerCase().trim().split(/\s+/u);

    if (!words[0]) {
        return messages;
    }

    return messages.filter((message) => {
        const haystack = [message.text, message.by?.name, message.by?.id]
            .filter(Boolean)
            .join(" ")
            .normalize("NFKC")
            .toLowerCase();

        return words.every((word) => haystack.includes(word));
    });
}

const emptyState = (conversationId = null, notice = null) => ({
    conversationId,
    messages: Object.freeze([]),
    before: null,
    loading: false,
    loadingAll: false,
    error: null,
    notice,
});

/**
 * Own one store per mounted outline. No text is persisted or sent to other services.
 * subscribe(listener) immediately supplies the current immutable snapshot.
 */
export function createMessageStore(pocket, { pageSize = 100 } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 200) {
        throw new RangeError("Page size must be an integer between 1 and 200.");
    }

    let state = Object.freeze(emptyState());
    let generation = 0;
    let controller = null;
    let started = false;
    let disposed = false;
    let unsubscribeConversation = null;
    let hasPage = false;
    const listeners = new Set();
    const usedCursors = new Set();

    function publish(patch) {
        state = Object.freeze({ ...state, ...patch });

        for (const listener of listeners) {
            listener(state);
        }
    }

    function invalidate() {
        generation += 1;
        controller?.abort();
        controller = null;
    }

    function isCurrent(token, conversationId) {
        return !disposed && token === generation && state.conversationId === conversationId;
    }

    async function reset(conversationId, notice = null) {
        if (disposed) {
            return false;
        }

        invalidate();
        usedCursors.clear();
        hasPage = false;
        publish(emptyState(conversationId, notice));

        return conversationId === null ? false : readPage(null, generation);
    }

    async function readPage(before, token) {
        const conversationId = state.conversationId;

        if (conversationId === null || !isCurrent(token, conversationId)) {
            return false;
        }

        const request = new AbortController();
        controller = request;
        publish({ loading: true, error: null });

        try {
            const page = await pocket.messages({ before, limit: pageSize, signal: request.signal });

            if (!isCurrent(token, conversationId) || request.signal.aborted) {
                return false;
            }

            // A request captures its session at invocation, not at resolution.
            if (page.conversationId !== conversationId) {
                throw new Error("The session changed while reading messages. Refresh to try again.");
            }

            if (
                !Array.isArray(page.messages) ||
                !(page.before === null || typeof page.before === "string")
            ) {
                throw new Error("Pocket returned an invalid message page. Refresh to try again.");
            }

            if (page.before !== null && (page.before === before || usedCursors.has(page.before))) {
                throw new Error("Pocket repeated a message cursor. Refresh to reload the timeline.");
            }

            const seen = new Set(state.messages.map((message) => message.id));
            const older = [];

            for (const message of [...page.messages].reverse()) {
                if (!seen.has(message.id)) {
                    seen.add(message.id);
                    older.push(message);
                }
            }

            if (before !== null) {
                usedCursors.add(before);
            }

            hasPage = true;
            publish({
                messages: Object.freeze([...state.messages, ...older]),
                before: page.before,
                loading: false,
                error: null,
            });

            return true;
        } catch (error) {
            if (!isCurrent(token, conversationId) || request.signal.aborted) {
                return false;
            }

            if (before !== null && error?.status === 409) {
                await reset(
                    conversationId,
                    "The session history changed. Reloaded the newest messages; load older messages again.",
                );

                return false;
            }

            publish({
                loading: false,
                error:
                    error instanceof Error
                        ? error.message
                        : "Could not load messages. Please try again.",
            });

            return false;
        } finally {
            if (controller === request) {
                controller = null;
            }
        }
    }

    function start() {
        if (started || disposed) {
            return Promise.resolve(false);
        }

        started = true;
        let firstLoad = Promise.resolve(false);
        let firstEvent = true;
        unsubscribeConversation = pocket.onConversation((conversationId) => {
            if (!firstEvent && conversationId === state.conversationId) {
                return;
            }

            firstEvent = false;
            firstLoad = reset(conversationId);
        });

        return firstLoad;
    }

    async function loadMore() {
        if (disposed || state.loading || state.loadingAll || (hasPage && state.before === null)) {
            return false;
        }

        return readPage(state.before, generation);
    }

    async function loadAll() {
        if (disposed || state.loading || state.loadingAll || state.conversationId === null) {
            return;
        }

        const token = generation;
        const conversationId = state.conversationId;
        publish({ loadingAll: true });

        try {
            while (isCurrent(token, conversationId) && (!hasPage || state.before !== null)) {
                const success = await readPage(state.before, token);

                if (!success || !isCurrent(token, conversationId) || state.before === null) {
                    break;
                }

                // Yield between pages, including when the host resolves from a cache.
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
        } finally {
            if (isCurrent(token, conversationId)) {
                publish({ loadingAll: false });
            }
        }
    }

    function cancelLoadAll() {
        if (disposed || !state.loadingAll) {
            return;
        }

        invalidate();
        publish({ loading: false, loadingAll: false });
    }

    function dispose() {
        if (disposed) {
            return;
        }

        disposed = true;
        invalidate();
        unsubscribeConversation?.();
        unsubscribeConversation = null;
        usedCursors.clear();
        hasPage = false;
        publish(emptyState());
        listeners.clear();
    }

    return {
        getSnapshot: () => state,
        subscribe(listener) {
            if (disposed) {
                listener(state);

                return () => {};
            }

            listeners.add(listener);
            listener(state);

            return () => listeners.delete(listener);
        },
        start,
        refresh: () => reset(state.conversationId),
        loadMore,
        loadAll,
        cancelLoadAll,
        dispose,
    };
}
