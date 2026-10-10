import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { Handler } from './gateway.js';

/**
 * What the app reads by itself, all the time, for features ALP has not got yet: project icons,
 * the checkout's git and pull request state, terminals, workspace setup, the daemon's config.
 * A refusal there would make the app retry and log errors without the user doing anything, so
 * these get the empty answer a daemon without that feature would give (ALPD §62). What the user
 * asks for by hand still answers "in development".
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;

export const quietHandlers: Record<string, Handler> = {
  project_icon_request: (message: Inbound<'project_icon_request'>) =>
    ({ type: 'project_icon_response', payload: { requestId: message.requestId, cwd: message.cwd, icon: null, error: null } }) satisfies Outbound,

  checkout_status_request: (message: Inbound<'checkout_status_request'>) => ({
    type: 'checkout_status_response',
    payload: {
      requestId: message.requestId, cwd: message.cwd, error: null, isGit: false, isPaseoOwnedWorktree: false, repoRoot: null, currentBranch: null,
      isDirty: null, baseRef: null, aheadBehind: null, aheadOfOrigin: null, behindOfOrigin: null, hasRemote: false, remoteUrl: null,
    },
  }) satisfies Outbound,

  checkout_pr_status_request: (message: Inbound<'checkout_pr_status_request'>) => ({
    type: 'checkout_pr_status_response',
    payload: { requestId: message.requestId, cwd: message.cwd, status: null, githubFeaturesEnabled: false, authState: 'unavailable', forge: 'github', error: null },
  }) satisfies Outbound,

  list_terminals_request: (message: Inbound<'list_terminals_request'>) =>
    ({ type: 'list_terminals_response', payload: { requestId: message.requestId, ...(message.cwd ? { cwd: message.cwd } : {}), terminals: [] } }) satisfies Outbound,

  subscribe_terminals_request: (message: Inbound<'subscribe_terminals_request'>) =>
    ({ type: 'terminals_changed', payload: { ...(message.requestId ? { requestId: message.requestId } : {}), cwd: message.cwd, ...(message.workspaceId ? { workspaceId: message.workspaceId } : {}), terminals: [] } }) satisfies Outbound,

  workspace_setup_status_request: (message: Inbound<'workspace_setup_status_request'>) =>
    ({ type: 'workspace_setup_status_response', payload: { requestId: message.requestId, workspaceId: message.workspaceId, snapshot: null } }) satisfies Outbound,

  get_daemon_config_request: (message: Inbound<'get_daemon_config_request'>) =>
    ({
      type: 'get_daemon_config_response',
      payload: {
        requestId: message.requestId,
        // Paseo's defaults: no Paseo MCP tools, no browser tools, no plugins of Paseo's own.
        config: { mcp: { enabled: false, injectIntoAgents: false }, browserTools: { enabled: false }, providers: {}, metadataGeneration: { providers: [] }, autoArchiveAfterMerge: false, enableTerminalAgentHooks: false, appendSystemPrompt: '', pluginsEnabled: false },
      },
    }) satisfies Outbound,

  // One-way: ALP keeps no terminal subscriptions.
  unsubscribe_terminals_request: () => undefined,
};
