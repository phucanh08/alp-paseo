import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// Keep the Claude SDK behind the runtime boundary. Paseo inspects static
// imports while compiling plugin entrypoints, including their declaration
// graph; the SDK is a daemon-only optional runtime dependency.
const CLAUDE_SDK = ['@anthropic-ai', 'claude-agent-sdk'].join('/');

type SDKUserMessage = any;
type SDKMessage = any;
type ClaudeQuery = AsyncGenerator<SDKMessage, void> & {
  interrupt(): Promise<unknown>;
  close(): void;
};

type Listener = (method: string, params: any) => void;
type RequestHandler = (method: string, params: any) => Promise<unknown>;

type NativeConfig = {
  cwd: string;
  model: string;
  sandbox: string;
  developerInstructions: string;
  mcpServers: Record<string, any>;
  thinking: string;
  dynamicTools: Array<{
    name: string;
    description: string;
  }>;
  ephemeral?: boolean;
  threadId?: string;
};

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiters: Array<(value: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;

  push(value: SDKUserMessage) {
    if (this.ended) throw new Error('Claude input is closed');
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Maps Claude Agent SDK streaming sessions to the normalized runtime protocol. */
export class ClaudeTransport {
  private listeners = new Set<Listener>();
  private failures = new Set<(error: Error) => void>();
  private requestHandler?: RequestHandler;
  private input = new InputQueue();
  private query?: ClaudeQuery;
  private pump?: Promise<void>;
  private config?: NativeConfig;
  private threadId = '';
  private activeTurn?: string;
  private closed = false;
  private assistantText = new Map<string, string>();
  private toolCalls = new Map<string, { name: string; command: string }>();

  constructor(
    private readonly command: string,
    private readonly cwd: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {
    if (/\.(cmd|bat|ps1)$/i.test(command)) {
      throw new Error('Claude executable must be a native binary, not a shell launcher');
    }
  }

  async initialize() {}

  onNotification(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onFailure(listener: (error: Error) => void) {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  onRequest(handler: RequestHandler) {
    this.requestHandler = handler;
  }

  async request(method: string, params: any): Promise<any> {
    if (this.closed) throw new Error('Runtime is closed');

    if (method === 'thread/start' || method === 'thread/resume') {
      this.config = params as NativeConfig;
      this.threadId =
        method === 'thread/resume' ? params.threadId : randomUUID();
      await this.start(method === 'thread/resume');
      return {
        thread: { id: this.threadId, turns: [] },
        cwd: this.cwd,
        model: params.model,
        reasoningEffort: params.thinking,
      };
    }

    if (method === 'turn/start' || method === 'turn/steer') {
      if (!this.query) throw new Error('Claude thread is not initialized');
      const turnId = method === 'turn/steer'
        ? params.expectedTurnId
        : randomUUID();
      if (method === 'turn/start') this.activeTurn = turnId;
      this.input.push({
        type: 'user',
        message: {
          role: 'user',
          content: params.input.map((part: any) => ({
            type: 'text',
            text: part.text,
          })),
        },
        parent_tool_use_id: null,
        uuid: randomUUID(),
        session_id: this.threadId,
      });
      return method === 'turn/start' ? { turn: { id: turnId } } : {};
    }

    if (method === 'turn/interrupt') {
      await this.query?.interrupt();
      return {};
    }

    throw new Error(`Unsupported Claude runtime operation '${method}'`);
  }

  private async start(resume: boolean) {
    const { createSdkMcpServer, query, tool } = await import(CLAUDE_SDK);
    const config = this.config!;
    const mcpServers = this.convertMcp(config.mcpServers);

    if (config.dynamicTools.length) {
      const definition = config.dynamicTools[0];
      const delegate = tool(
        definition.name,
        definition.description,
        {
          agent: z.string().min(1),
          task: z.string().min(1).max(32_000),
          mode: z.enum(['read-only', 'workspace-write']).optional(),
        },
        async (args: { agent: string; task: string; mode?: 'read-only' | 'workspace-write' }) => {
          if (!this.requestHandler || !this.activeTurn) {
            return {
              content: [{ type: 'text', text: 'Delegation is unavailable' }],
              isError: true,
            };
          }
          const callId = `claude-tool-${randomUUID()}`;
          this.emit('item/started', {
            threadId: this.threadId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              callId,
              tool: definition.name,
              arguments: args,
              status: 'inProgress',
            },
          });
          const result: any = await this.requestHandler('item/tool/call', {
            threadId: this.threadId,
            turnId: this.activeTurn,
            callId,
            namespace: null,
            tool: definition.name,
            arguments: args,
          });
          this.emit('item/completed', {
            threadId: this.threadId,
            item: {
              type: 'dynamicToolCall',
              id: callId,
              callId,
              tool: definition.name,
              arguments: args,
              status: result?.success === false ? 'failed' : 'completed',
              success: result?.success !== false,
              contentItems: result?.contentItems ?? [],
            },
          });
          return {
            content: (result?.contentItems ?? []).map((item: any) => ({
              type: 'text' as const,
              text: item.text ?? JSON.stringify(item),
            })),
            isError: result?.success === false,
          };
        },
      );
      mcpServers.alp = createSdkMcpServer({
        name: 'alp',
        version: '0.0.0',
        tools: [delegate],
      });
    }

    const options = {
      cwd: config.cwd,
      env: this.env,
      model: config.model,
      effort: ['none', 'off', 'ultracode'].includes(config.thinking) ? undefined : config.thinking,
      thinking: ['none', 'off'].includes(config.thinking) ? { type: 'disabled' } : { type: 'adaptive' },
      ...(config.thinking === 'ultracode' ? { settings: { ultracode: true } } : {}),
      systemPrompt: config.developerInstructions,
      permissionMode: config.sandbox === 'read-only' ? 'plan' : 'acceptEdits',
      canUseTool: async (name: string, input: Record<string, unknown>) => {
        if (config.sandbox === 'read-only') {
          const allowed = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'];
          if (!allowed.includes(name) && name !== 'mcp__alp__alp_delegate') {
            return { behavior: 'deny', message: 'ALP session is read-only' };
          }
        }
        return { behavior: 'allow', updatedInput: input };
      },
      mcpServers,
      strictMcpConfig: true,
      settingSources: [],
      disallowedTools: ['Agent', 'Task', 'TeamCreate'],
      persistSession: !config.ephemeral,
      promptSuggestions: false,
      includePartialMessages: false,
      ...(resume ? { resume: this.threadId } : { sessionId: this.threadId }),
      ...(this.command !== 'claude'
        ? { pathToClaudeCodeExecutable: this.command }
        : {}),
    };

    this.query = query({ prompt: this.input, options }) as ClaudeQuery;
    this.pump = this.consume(this.query).catch((error) => this.fail(error));
  }

  private convertMcp(values: Record<string, any>) {
    const result: Record<string, any> = {};
    for (const [name, value] of Object.entries(values)) {
      result[name] = value.url
        ? {
            type: 'http',
            url: value.url,
            headers: value.http_headers ?? {},
          }
        : {
            type: 'stdio',
            command: value.command,
            args: value.args ?? [],
            env: value.env ?? {},
          };
    }
    return result;
  }

  private async consume(stream: ClaudeQuery) {
    for await (const message of stream) this.handle(message);
    if (!this.closed) this.fail(new Error('Claude session exited'));
  }

  private handle(message: SDKMessage) {
    if (message.type === 'assistant' && !message.parent_tool_use_id) {
      for (const block of message.message.content as any[]) {
        if (block.type === 'text') {
          const id = message.message.id;
          const text = (this.assistantText.get(id) ?? '') + block.text;
          this.assistantText.set(id, text);
          this.emit('item/completed', {
            threadId: this.threadId,
            item: { type: 'agentMessage', id, text },
          });
        } else if (block.type === 'tool_use') {
          const command = block.name === 'Bash'
            ? String(block.input?.command ?? '')
            : `${block.name} ${JSON.stringify(block.input ?? {})}`;
          this.toolCalls.set(block.id, { name: block.name, command });
          this.emit('item/started', {
            threadId: this.threadId,
            item: {
              type: 'commandExecution',
              id: block.id,
              command,
              cwd: this.cwd,
              status: 'inProgress',
              aggregatedOutput: '',
            },
          });
        }
      }
      return;
    }

    if (message.type === 'user') {
      const content = Array.isArray(message.message.content)
        ? message.message.content as any[]
        : [];
      for (const block of content) {
        if (block.type !== 'tool_result') continue;
        const call = this.toolCalls.get(block.tool_use_id);
        if (!call) continue;
        const output = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content ?? '');
        this.emit('item/completed', {
          threadId: this.threadId,
          item: {
            type: 'commandExecution',
            id: block.tool_use_id,
            command: call.command,
            cwd: this.cwd,
            status: block.is_error ? 'failed' : 'completed',
            exitCode: block.is_error ? 1 : 0,
            aggregatedOutput: output,
          },
        });
        this.toolCalls.delete(block.tool_use_id);
      }
      return;
    }

    if (message.type === 'result' && this.activeTurn) {
      const turnId = this.activeTurn;
      this.activeTurn = undefined;
      this.emit('turn/completed', {
        threadId: this.threadId,
        turn: {
          id: turnId,
          status: message.is_error ? 'failed' : 'completed',
          ...(message.is_error
            ? { error: { message: 'errors' in message ? message.errors.join('; ') : 'Claude turn failed' } }
            : {}),
        },
      });
    }
  }

  private emit(method: string, params: any) {
    for (const listener of this.listeners) listener(method, params);
  }

  private fail(value: unknown) {
    if (this.closed) return;
    const error = value instanceof Error ? value : new Error(String(value));
    for (const listener of this.failures) listener(error);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.input.close();
    this.query?.close();
    await this.pump?.catch(() => {});
    this.listeners.clear();
    this.failures.clear();
  }
}
