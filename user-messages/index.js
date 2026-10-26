import { createMessageStore, filterMessages, previewText } from "./model.js";

export const pocketApi = 1;

const SHEET_ID = "user-messages";
const VISIBLE_BATCH = 100;

export default function setup(pocket) {
    const { html, useEffect, useState, useMemo } = pocket;
    const supported = ["messages", "reveal", "onConversation"].every(
        (name) => typeof pocket[name] === "function",
    );
    let disposed = false;
    let jumpVersion = 0;
    const stores = new Set();

    pocket.style("style.css");

    function YourMessages() {
        if (!supported) {
            return html`<p class="error-box">Your messages requires Pi Pocket 0.20.0 or newer.</p>`;
        }

        const [store] = useState(() => createMessageStore(pocket));
        const [state, setState] = useState(() => store.getSnapshot());
        const [query, setQuery] = useState("");
        const [visibleCount, setVisibleCount] = useState(VISIBLE_BATCH);
        const [jumping, setJumping] = useState(false);

        useEffect(() => {
            stores.add(store);
            const unsubscribe = store.subscribe(setState);

            store.start();

            return () => {
                unsubscribe();
                store.dispose();
                stores.delete(store);
            };
        }, [store]);

        useEffect(() => {
            setQuery("");
            setJumping(false);
        }, [state.conversationId]);

        useEffect(() => {
            setVisibleCount(VISIBLE_BATCH);
        }, [query, state.conversationId]);

        const filtered = useMemo(
            () => filterMessages(state.messages, query),
            [state.messages, query],
        );
        const visible = filtered.slice(0, visibleCount);
        const hasSession = state.conversationId !== null;
        const busy = state.loading || state.loadingAll;

        return html`
            <section class="um-outline" aria-label="Your messages">
                <p class="um-help">Choose a message to jump to it. Tap it in the conversation, then choose <strong>Edit and send again</strong> to fork (if you can steer).</p>
                ${state.notice && html`<p class="um-notice" role="status">${state.notice}</p>`}
                <div class="um-toolbar">
                    <label class="um-search">
                        <span class="um-sr-only">Filter user messages</span>
                        <input
                            type="search"
                            placeholder="Filter messages or people…"
                            value=${query}
                            disabled=${!hasSession}
                            onInput=${(event) => setQuery(event.currentTarget.value)}
                        />
                    </label>
                    <button
                        type="button"
                        class="button"
                        disabled=${!hasSession || busy}
                        onClick=${() => store.refresh()}
                    >Refresh</button>
                </div>
                <div class="um-summary" role="status" aria-live="polite" aria-atomic="true">
                    ${query.trim() ? `${filtered.length} matching · ` : ""}${state.messages.length} loaded · newest first
                    ${state.before ? " · older messages available" : ""}
                </div>
                ${hasSession && html`<p class="um-search-note muted small">Filter checks loaded message excerpts (up to 1,000 characters each). Load all to include older messages.</p>`}
                ${state.error && html`
                    <div class="error-box" role="alert">
                        <p>${state.error}</p>
                        <button type="button" class="button" disabled=${busy}
                            onClick=${() => state.messages.length && state.before ? store.loadMore() : store.refresh()}
                        >Retry</button>
                    </div>
                `}
                ${!hasSession && html`<p class="um-empty">Open a session to browse its user messages.</p>`}
                ${hasSession && !busy && !state.error && filtered.length === 0 && html`
                    <p class="um-empty">${query.trim()
                        ? "No matching messages in the loaded history."
                        : "No user messages in the current transcript."}</p>
                `}
                <ol class="um-list" aria-label="User messages, newest first" aria-busy=${busy}>
                    ${visible.map((message) => html`
                        <li key=${message.id}>
                            <button
                                type="button"
                                class="um-message"
                                disabled=${jumping}
                                onClick=${async () => {
                                    if (pocket.conversationId() === state.conversationId) {
                                        const version = ++jumpVersion;
                                        setJumping(true);
                                        await jumpToMessage(pocket, message.id, state.conversationId,
                                            () => !disposed && version === jumpVersion);

                                        if (stores.has(store)) {
                                            setJumping(false);
                                        }
                                    }
                                }}
                            >
                                <span class="um-meta">
                                    <span class="um-author">${message.by?.name || "User"}</span>
                                    ${formatTime(message.at, html)}
                                </span>
                                <span class="um-preview" dir="auto">${previewText(message)}</span>
                                <span class="um-jump">Jump to message${message.clipped ? " · excerpt" : ""}<span aria-hidden="true"> ↗</span></span>
                            </button>
                        </li>
                    `)}
                </ol>
                ${filtered.length > visibleCount && html`
                    <button type="button" class="button um-more"
                        onClick=${() => setVisibleCount((count) => count + VISIBLE_BATCH)}
                    >Show more matches (${filtered.length - visibleCount} remaining)</button>
                `}
                <div class="um-footer">
                    ${busy && html`<span role="status">${state.loadingAll ? "Loading older history…" : "Loading messages…"}</span>`}
                    ${state.loadingAll ? html`
                        <button type="button" class="button" onClick=${() => store.cancelLoadAll()}>Stop loading</button>
                    ` : state.before && html`
                        <button type="button" class="button" disabled=${busy} onClick=${() => store.loadMore()}>Load older</button>
                        <button type="button" class="button" disabled=${busy} onClick=${() => store.loadAll()}>Load all</button>
                    `}
                </div>
            </section>
        `;
    }

    pocket.sheet({ id: SHEET_ID, title: "Your messages", component: YourMessages, wide: true });
    pocket.menu({
        id: SHEET_ID,
        label: "Your messages",
        hint: "Find a fork point",
        group: "session",
        sheet: SHEET_ID,
    });
    pocket.launcher({
        id: SHEET_ID,
        label: "Your messages",
        detail: "Browse user prompts and jump to a fork point",
        icon: "chat",
        keywords: ["timeline", "outline", "fork", "prompts", "history", "用户消息", "分叉"],
        sheet: SHEET_ID,
    });

    if (typeof pocket.topbar === "function") {
        pocket.topbar({ id: SHEET_ID, title: "Your messages", icon: "chat", sheet: SHEET_ID });
    }

    return () => {
        disposed = true;
        jumpVersion++;

        for (const store of stores) {
            store.dispose();
        }

        stores.clear();
    };
}

// reveal closes the sheet itself; false can also mean another app jump won.
// Never reopen our sheet over that newer navigation.
export async function jumpToMessage(pocket, id, conversationId, isActive = () => true) {
    const current = () => isActive() && pocket.conversationId() === conversationId;

    if (!current()) {
        return false;
    }

    try {
        const revealed = await pocket.reveal(id);

        if (!revealed && current()) {
            pocket.notify("info", "Jump cancelled or message unavailable. Open Your messages and refresh to try again.");
        }

        return revealed;
    } catch (error) {
        if (current()) {
            pocket.notify("error", `Could not jump to the message: ${error?.message || "Please try again."}`);
        }

        return false;
    }
}

function formatTime(at, html) {
    if (at === null || at === undefined) {
        return null;
    }

    const date = new Date(at);

    if (!Number.isFinite(date.getTime())) {
        return null;
    }

    return html`<time dateTime=${date.toISOString()}>${date.toLocaleString(undefined, {
        month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    })}</time>`;
}
