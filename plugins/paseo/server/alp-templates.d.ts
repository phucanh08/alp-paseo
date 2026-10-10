declare module 'alp:templates' {
  const templates: Record<string, string>;
  export default templates;
}

declare module 'alp:web' {
  const assets: Record<string, { type: string; body: string }>;
  export default assets;
}

declare module 'alp:plugin-client' {
  const plugin: { id: string; requirements: { paseo?: string }; factory: string };
  export default plugin;
}
