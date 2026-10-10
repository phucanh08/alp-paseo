/**
 * The tasks each root session's tree worked on, by the session id Paseo knows (ALPD §55).
 * ALP reports them as a todo list; Paseo would show that as a second tasks pill that
 * opens nothing, so the provider keeps them here and the Tasks pill shows them first.
 */
export const sessionTasks = new Map<string, string[]>();
