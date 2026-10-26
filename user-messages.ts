/**
 * Browse the current session's user messages and jump to a useful fork point.
 * Adds a searchable, paginated outline through Pi Pocket's browser extension API.
 */
export const pocketApi = 1;

export default function userMessages(
    _host: unknown,
    web: { client(entry: string, options: { access: "view" }): void },
) {
    web.client("user-messages", { access: "view" });
}
